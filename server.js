const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const { init, getAccounts, getTransactions, getCategories, updateTransaction, getBudgets, loadBudget, downloadBudget, getPayees } = require('@actual-app/api');

// Disable SSL verification for self-signed certificates on local network
if (process.env.NODE_ENV !== 'production') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuration from environment variables
const AB_SERVER = process.env.AB_SERVER || '192.168.10.53';
const AB_PORT = process.env.AB_PORT || 5006;
const AB_USE_HTTPS = process.env.AB_USE_HTTPS !== 'false'; // default true
const AB_PASSWORD = process.env.AB_PASSWORD;
const AB_ENCRYPTION_PASSWORD = process.env.AB_ENCRYPTION_PASSWORD;
const AB_DATA_DIR = process.env.AB_DATA_DIR || path.join(process.cwd(), '.actual-data');
const AB_SYNC_ID = process.env.AB_SYNC_ID;

const protocol = AB_USE_HTTPS ? 'https' : 'http';
const serverURL = `${protocol}://${AB_SERVER}:${AB_PORT}`;

let isConnected = false;
let currentBudgetId = null;
let connectPromise = null;
let actualApiQueue = Promise.resolve();

function formatApiError(error) {
  if (!error) return 'unknown-error';
  if (typeof error === 'string') return error;
  if (error.reason) return error.reason;
  if (error.message) return error.message;
  return JSON.stringify(error);
}

function isNoBudgetOpenError(error) {
  const message = (error && error.message) ? String(error.message) : String(error || '');
  return message.includes('No budget file is open');
}

async function loadBudgetChecked(budgetId) {
  const result = await loadBudget(budgetId);
  if (result && result.error) {
    throw new Error(`loadBudget failed: ${formatApiError(result.error)}`);
  }
}

async function tryLoadUsableBudget(budgetId) {
  try {
    await loadBudgetChecked(budgetId);
    await getAccounts();
    return true;
  } catch (error) {
    if (isNoBudgetOpenError(error)) {
      return false;
    }
    throw error;
  }
}

function getLocalBudgets(budgets) {
  return (budgets || []).filter(b => b && b.state !== 'remote' && b.id);
}

function isUncategorizedTransaction(transaction) {
  return !transaction.category;
}

function normalizeDateInput(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function getDateRangeFromSource(source = {}) {
  return {
    startDate: normalizeDateInput(source.startDate),
    endDate: normalizeDateInput(source.endDate)
  };
}

function isInDateRange(transaction, startDate, endDate) {
  const date = transaction && transaction.date ? String(transaction.date) : null;
  if (!date) {
    return false;
  }

  if (startDate && date < startDate) {
    return false;
  }

  if (endDate && date > endDate) {
    return false;
  }

  return true;
}

// Initialize connection to Actual Budget
async function connectToActualBudget() {
  if (connectPromise) {
    return connectPromise;
  }

  connectPromise = (async () => {
    try {
      if (!isConnected) {
        // Ensure Actual data directory exists before API init.
        if (!fs.existsSync(AB_DATA_DIR)) {
          fs.mkdirSync(AB_DATA_DIR, { recursive: true });
        }

        // Initialize the connection
        await init({
          serverURL: serverURL,
          password: AB_PASSWORD,
          encryptionPassword: AB_ENCRYPTION_PASSWORD,
          dataDir: AB_DATA_DIR
        });

        isConnected = true;
        console.log(`Connected to Actual Budget at ${serverURL}`);
        console.log(`Using Actual data dir: ${AB_DATA_DIR}`);
      }

      if (!currentBudgetId) {
        let budgets = await getBudgets();
        let localBudgets = getLocalBudgets(budgets);

        // If only remote metadata is available, download via explicit sync ID.
        if (localBudgets.length === 0 && AB_SYNC_ID) {
          const downloadedId = await downloadBudget(AB_SYNC_ID);
          if (downloadedId && downloadedId.error) {
            throw new Error(`downloadBudget failed: ${formatApiError(downloadedId.error)}`);
          }
          console.log(`Downloaded budget using AB_SYNC_ID: ${AB_SYNC_ID}`);
          budgets = await getBudgets();
          localBudgets = getLocalBudgets(budgets);
        }

        if (localBudgets.length === 0) {
          throw new Error('No local budget found. Add AB_SYNC_ID in .env to download your budget, then restart.');
        }

        let loadedBudget = null;
        for (const budget of localBudgets) {
          const usable = await tryLoadUsableBudget(budget.id);
          if (usable) {
            currentBudgetId = budget.id;
            loadedBudget = budget;
            break;
          }
        }

        if (!loadedBudget) {
          throw new Error('Unable to open any local budget file. Verify AB_PASSWORD and AB_ENCRYPTION_PASSWORD.');
        }

        console.log(`Loaded budget: ${loadedBudget.name || currentBudgetId}`);
      } else {
        const usable = await tryLoadUsableBudget(currentBudgetId);
        if (!usable) {
          currentBudgetId = null;
          await connectToActualBudget();
        }
      }
    } catch (error) {
      // Reset connection state on error
      isConnected = false;
      currentBudgetId = null;
      console.error(`Failed to connect to Actual Budget at ${serverURL}:`, error.message);
      throw error;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

// Initialize on startup
connectToActualBudget().then(() => {
  console.log('Initial connection established');
}).catch(error => {
  console.error('Failed to establish initial connection:', error.message);
  console.log('Will attempt connection on first API request');
});

// Ensure budget is loaded before API operations
async function ensureBudgetLoaded() {
  try {
    if (!currentBudgetId) {
      await connectToActualBudget();
      return;
    }
    // Fast health check for currently opened budget context.
    await getAccounts();
  } catch (error) {
    console.warn('Failed to ensure budget loaded, reconnecting...', error.message);
    isConnected = false;
    currentBudgetId = null;
    await connectToActualBudget();
  }
}

// Actual API keeps budget context globally; serialize access to avoid races.
function withActualApiLock(operation) {
  const run = async () => operation();
  const next = actualApiQueue.then(run, run);
  actualApiQueue = next.catch(() => {});
  return next;
}

async function runActualOperation(operation) {
  return withActualApiLock(async () => {
    try {
      await ensureBudgetLoaded();
      return await operation();
    } catch (error) {
      if (!isNoBudgetOpenError(error)) {
        throw error;
      }

      console.warn('Budget context missing during operation, reconnecting and retrying once...');
      isConnected = false;
      currentBudgetId = null;
      await connectToActualBudget();
      await ensureBudgetLoaded();
      return await operation();
    }
  });
}

// Get all unique payees and their transaction counts
app.get('/api/payees', async (req, res) => {
  try {
    const { startDate, endDate } = getDateRangeFromSource(req.query);
    const payees = await runActualOperation(async () => {

      const accounts = await getAccounts();
      const payeeRecords = await getPayees();
      const payeeNamesById = new Map(
        (payeeRecords || []).map(p => [p.id, p.name || p.id])
      );
      const payeeMap = {};

      // Collect all transactions and count by payee
      for (const account of accounts) {
        const transactions = await getTransactions(account.id);

        for (const trans of transactions) {
          if (trans.payee && isUncategorizedTransaction(trans) && isInDateRange(trans, startDate, endDate)) {
            if (!payeeMap[trans.payee]) {
              payeeMap[trans.payee] = {
                payee: trans.payee,
                payeeName: payeeNamesById.get(trans.payee) || trans.payee,
                count: 0,
                category: null
              };
            }
            payeeMap[trans.payee].count++;
            // Capture first non-null category if available
            if (trans.category && !payeeMap[trans.payee].category) {
              payeeMap[trans.payee].category = trans.category;
            }
          }
        }
      }

      return Object.values(payeeMap).sort((a, b) => 
        b.count - a.count // Sort by count descending
      );
    });

    res.json(payees);
  } catch (error) {
    console.error('Error fetching payees:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all available categories
app.get('/api/categories', async (req, res) => {
  try {
    const categories = await runActualOperation(async () => {
      return getCategories();
    });

    res.json(categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get transactions for a specific payee
app.get('/api/transactions/:payee', async (req, res) => {
  try {
    const { startDate, endDate } = getDateRangeFromSource(req.query);
    const transactions = await runActualOperation(async () => {

      const { payee } = req.params;
      const decodedPayee = decodeURIComponent(payee);
      const accounts = await getAccounts();
      const matches = [];

      for (const account of accounts) {
        const trans = await getTransactions(account.id);
        matches.push(
          ...trans.filter(t =>
            t.payee === decodedPayee &&
            isUncategorizedTransaction(t) &&
            isInDateRange(t, startDate, endDate)
          )
        );
      }

      return matches;
    });

    res.json(transactions);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk update category for all transactions with a specific payee
app.post('/api/bulk-update-category', async (req, res) => {
  try {
    const { payee, categoryId, transactionIds } = req.body;
    
    if (!payee || !categoryId) {
      return res.status(400).json({ error: 'Payee and categoryId are required' });
    }

    if (transactionIds !== undefined) {
      if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
        return res.status(400).json({ error: 'transactionIds must be a non-empty array when provided' });
      }
    }

    const transactionIdSet = Array.isArray(transactionIds) ? new Set(transactionIds) : null;

    const updatedCount = await runActualOperation(async () => {

      const accounts = await getAccounts();
      let count = 0;

      for (const account of accounts) {
        const transactions = await getTransactions(account.id);

        for (const trans of transactions) {
          const isSelected = !transactionIdSet || transactionIdSet.has(trans.id);
          if (
            trans.payee === payee &&
            isUncategorizedTransaction(trans) &&
            isSelected
          ) {
            await updateTransaction(trans.id, { category: categoryId });
            count++;
          }
        }
      }

      return count;
    });
    
    res.json({ 
      success: true, 
      message: `Updated ${updatedCount} transactions`,
      updatedCount 
    });
  } catch (error) {
    console.error('Error updating transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  res.json({ 
    status: 'ok',
    connected: isConnected 
  });
});

app.listen(PORT, () => {
  console.log(`Categorizer server running on http://localhost:${PORT}`);
  console.log(`Will connect to Actual Budget at ${serverURL}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
