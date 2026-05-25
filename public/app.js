// Global state
let payees = [];
let categories = [];
let selectedPayee = null;
let selectedCategory = null;
let dateRange = { startDate: '', endDate: '' };
const expandedPayees = new Set();
const transactionDetailsCache = new Map();
const selectedTransactionIdsByPayee = new Map();
const transactionSortState = new Map(); // { payeeId: { column: 'date'|'amount'|'notes', ascending: true/false } }

// DOM Elements
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const mainUiEl = document.getElementById('main-ui');
const startDateEl = document.getElementById('startDate');
const endDateEl = document.getElementById('endDate');
const payeeSearchEl = document.getElementById('payeeSearch');
const payeeListEl = document.getElementById('payeeList');
const categorySectionEl = document.getElementById('categorySection');
const categoryListEl = document.getElementById('categoryList');
const selectedPayeeNameEl = document.getElementById('selectedPayeeName');
const transactionCountEl = document.getElementById('transactionCount');
const backBtnEl = document.getElementById('backBtn');
const confirmBtnEl = document.getElementById('confirmBtn');
const successSectionEl = document.getElementById('successSection');
const successMessageEl = document.getElementById('successMessage');
const nextBtnEl = document.getElementById('nextBtn');

// Initialize
async function init() {
  try {
    showLoading();

    const categoriesRes = await fetch('/api/categories');
    if (!categoriesRes.ok) {
      throw new Error('Failed to fetch categories from server');
    }

    categories = await categoriesRes.json();
    await loadPayees();

    hideLoading();
    setupEventListeners();
  } catch (error) {
    showError(`Failed to initialize: ${error.message}`);
    console.error(error);
  }
}

function setupEventListeners() {
  payeeSearchEl.addEventListener('input', handlePayeeSearch);
  startDateEl.addEventListener('change', handleDateChange);
  endDateEl.addEventListener('change', handleDateChange);
  backBtnEl.addEventListener('click', handleBack);
  confirmBtnEl.addEventListener('click', handleConfirm);
  nextBtnEl.addEventListener('click', handleNext);
}

async function handleDateChange() {
  const nextRange = {
    startDate: startDateEl.value || '',
    endDate: endDateEl.value || ''
  };

  if (nextRange.startDate && nextRange.endDate && nextRange.startDate > nextRange.endDate) {
    showError('Start date must be on or before end date');
    return;
  }

  dateRange = nextRange;
  resetSelectionUi();

  try {
    showLoading();
    await loadPayees();
    hideLoading();
  } catch (error) {
    showError(`Failed to load payees: ${error.message}`);
  }
}

async function loadPayees() {
  const response = await fetch(`/api/payees?${buildDateRangeParams().toString()}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch payees from server');
  }

  payees = await response.json();
  renderPayees(payees);
}

function handlePayeeSearch(e) {
  const query = e.target.value.toLowerCase();
  const filtered = payees.filter(p =>
    (p.payeeName || p.payee).toLowerCase().includes(query) ||
    p.payee.toLowerCase().includes(query)
  );
  renderPayees(filtered);
}

function renderPayees(payeesToRender) {
  payeeListEl.innerHTML = '';

  if (payeesToRender.length === 0) {
    payeeListEl.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">No payee groups found for this period</p>';
    return;
  }

  payeesToRender.forEach(payee => {
    const item = document.createElement('div');
    item.className = 'payee-item';
    const isExpanded = expandedPayees.has(payee.payee);
    const selectedCount = getSelectedTransactionIds(payee.payee).size;

    item.innerHTML = `
      <div class="payee-main">
        <div class="payee-meta">
          <span class="payee-name">${escapeHtml(payee.payeeName || payee.payee)}</span>
          <span class="payee-count">${payee.count} transactions</span>
          ${selectedCount > 0 ? `<span class="payee-selected-count">${selectedCount} selected</span>` : ''}
        </div>
        <div class="payee-actions">
          <button class="btn-mini btn-ghost" data-role="toggle-details">${isExpanded ? 'Hide transactions' : 'Show transactions'}</button>
          <button class="btn-mini btn-primary-lite" data-role="categorize">Categorize selected</button>
        </div>
      </div>
      <div class="payee-details" style="display: ${isExpanded ? 'block' : 'none'}"></div>
    `;

    const toggleBtn = item.querySelector('[data-role="toggle-details"]');
    const categorizeBtn = item.querySelector('[data-role="categorize"]');
    const detailsEl = item.querySelector('.payee-details');

    toggleBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      togglePayeeDetails(payee, detailsEl, toggleBtn);
    });

    categorizeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      selectPayee(payee);
    });

    if (isExpanded) {
      togglePayeeDetails(payee, detailsEl, toggleBtn, true);
    }

    payeeListEl.appendChild(item);
  });
}

async function togglePayeeDetails(payee, detailsEl, toggleBtn, forceOpen = false) {
  const isOpen = expandedPayees.has(payee.payee);
  const shouldOpen = forceOpen || !isOpen;

  if (!shouldOpen) {
    expandedPayees.delete(payee.payee);
    detailsEl.style.display = 'none';
    toggleBtn.textContent = 'Show transactions';
    return;
  }

  expandedPayees.add(payee.payee);
  detailsEl.style.display = 'block';
  toggleBtn.textContent = 'Hide transactions';

  const cacheKey = `${payee.payee}|${dateRange.startDate}|${dateRange.endDate}`;
  if (transactionDetailsCache.has(cacheKey)) {
    renderPayeeDetails(payee, detailsEl, transactionDetailsCache.get(cacheKey));
    return;
  }

  detailsEl.innerHTML = '<div class="payee-details-loading">Loading transactions...</div>';

  try {
    const response = await fetch(`/api/transactions/${encodeURIComponent(payee.payee)}?${buildDateRangeParams().toString()}`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to load transactions');
    }

    const transactions = await response.json();
    transactionDetailsCache.set(cacheKey, transactions);
    renderPayeeDetails(payee, detailsEl, transactions);
  } catch (error) {
    detailsEl.innerHTML = `<div class="payee-details-error">${escapeHtml(error.message)}</div>`;
  }
}

function renderPayeeDetails(payee, detailsEl, transactions) {
  if (!transactions.length) {
    detailsEl.innerHTML = '<div class="payee-details-empty">No transactions found for this payee in the selected date range.</div>';
    return;
  }

  const selectedIds = getSelectedTransactionIds(payee.payee);
  const selectedCount = selectedIds.size;

  // Get sort state for this payee
  let sortState = transactionSortState.get(payee.payee);
  if (!sortState) {
    sortState = { column: 'date', ascending: false };
    transactionSortState.set(payee.payee, sortState);
  }

  // Sort transactions based on current sort state
  const sortedTransactions = transactions.slice();
  sortedTransactions.sort((a, b) => {
    let aVal, bVal;
    
    if (sortState.column === 'date') {
      aVal = String(a.date);
      bVal = String(b.date);
    } else if (sortState.column === 'amount') {
      aVal = Number(a.amount || 0);
      bVal = Number(b.amount || 0);
    } else if (sortState.column === 'notes') {
      aVal = String(a.notes || '');
      bVal = String(b.notes || '');
    }

    if (aVal < bVal) return sortState.ascending ? -1 : 1;
    if (aVal > bVal) return sortState.ascending ? 1 : -1;
    return 0;
  });

  const rows = sortedTransactions
    .map((t) => {
      const notes = t.notes ? escapeHtml(t.notes) : '<span class="muted">-</span>';
      const checked = selectedIds.has(t.id) ? 'checked' : '';
      const selectedClass = selectedIds.has(t.id) ? 'is-selected' : '';
      return `
        <tr class="transaction-row ${selectedClass}" data-transaction-id="${escapeHtml(t.id)}">
          <td>
            <input
              type="checkbox"
              class="transaction-select"
              data-transaction-id="${escapeHtml(t.id)}"
              ${checked}
            >
          </td>
          <td>${escapeHtml(formatDate(t.date))}</td>
          <td class="amount-cell">${escapeHtml(formatAmount(t.amount))}</td>
          <td>${notes}</td>
        </tr>
      `;
    })
    .join('');

  const getSortIndicator = (column) => {
    if (sortState.column !== column) return '';
    return sortState.ascending ? ' ▲' : ' ▼';
  };

  detailsEl.innerHTML = `
    <div class="payee-details-toolbar">
      <label class="select-all-toggle">
        <input type="checkbox" data-role="select-all" ${selectedCount === transactions.length ? 'checked' : ''}>
        Select all (${transactions.length})
      </label>
      <span class="selected-indicator">${selectedCount} selected</span>
    </div>
    <div class="payee-details-table-wrap">
      <table class="payee-details-table">
        <thead>
          <tr>
            <th></th>
            <th class="sortable-header" data-sort-column="date">Date${getSortIndicator('date')}</th>
            <th class="sortable-header" data-sort-column="amount">Amount${getSortIndicator('amount')}</th>
            <th class="sortable-header" data-sort-column="notes">Notes${getSortIndicator('notes')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  const selectAllEl = detailsEl.querySelector('[data-role="select-all"]');
  const transactionRows = detailsEl.querySelectorAll('.transaction-row');
  const rowCheckboxes = detailsEl.querySelectorAll('.transaction-select');
  const sortHeaders = detailsEl.querySelectorAll('.sortable-header');
  let lastInteractedIndex = null;

  // Add sort header click handlers
  sortHeaders.forEach(header => {
    header.addEventListener('click', () => {
      const column = header.dataset.sortColumn;
      if (sortState.column === column) {
        sortState.ascending = !sortState.ascending;
      } else {
        sortState.column = column;
        sortState.ascending = false;
      }
      transactionSortState.set(payee.payee, sortState);
      renderPayeeDetails(payee, detailsEl, transactions);
    });
  });

  function refreshSelectionUi() {
    const selectedNow = getSelectedTransactionIds(payee.payee).size;
    const indicator = detailsEl.querySelector('.selected-indicator');
    if (indicator) {
      indicator.textContent = `${selectedNow} selected`;
    }
    selectAllEl.checked = selectedNow === rowCheckboxes.length;

    transactionRows.forEach(row => {
      const id = row.dataset.transactionId;
      row.classList.toggle('is-selected', getSelectedTransactionIds(payee.payee).has(id));
    });
  }

  selectAllEl.addEventListener('change', (event) => {
    const checked = event.target.checked;
    rowCheckboxes.forEach(cb => {
      cb.checked = checked;
      updateTransactionSelection(payee.payee, cb.dataset.transactionId, checked);
    });
    lastInteractedIndex = null;
    refreshSelectionUi();
    renderPayees(payees);
  });

  transactionRows.forEach(row => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('.transaction-select')) {
        return;
      }

      const checkbox = row.querySelector('.transaction-select');
      if (!checkbox) {
        return;
      }

      const currentIndex = Array.from(rowCheckboxes).indexOf(checkbox);
      const nextChecked = !checkbox.checked;

      if (event.shiftKey && lastInteractedIndex !== null) {
        applySelectionRange(payee.payee, rowCheckboxes, lastInteractedIndex, currentIndex, nextChecked);
      } else {
        checkbox.checked = nextChecked;
        updateTransactionSelection(payee.payee, checkbox.dataset.transactionId, nextChecked);
      }

      lastInteractedIndex = currentIndex;
      refreshSelectionUi();
      renderPayees(payees);
    });
  });

  sortHeaders.forEach(header => {
    header.addEventListener('click', () => {
      const column = header.dataset.sortColumn;
      if (sortState.column === column) {
        sortState.ascending = !sortState.ascending;
      } else {
        sortState.column = column;
        sortState.ascending = false;
      }
      transactionSortState.set(payee.payee, sortState);
      renderPayeeDetails(payee, detailsEl, transactions);
    });
  });

  rowCheckboxes.forEach(cb => {
    cb.addEventListener('click', (event) => {
      cb.dataset.shiftClick = event.shiftKey ? '1' : '0';
    });
  });

  rowCheckboxes.forEach(cb => {
    cb.addEventListener('change', (event) => {
      const currentIndex = Array.from(rowCheckboxes).indexOf(event.target);
      const shiftClick = event.target.dataset.shiftClick === '1';
      delete event.target.dataset.shiftClick;

      if (shiftClick && lastInteractedIndex !== null) {
        applySelectionRange(
          payee.payee,
          rowCheckboxes,
          lastInteractedIndex,
          currentIndex,
          event.target.checked
        );
      } else {
        updateTransactionSelection(payee.payee, event.target.dataset.transactionId, event.target.checked);
      }

      lastInteractedIndex = currentIndex;
      refreshSelectionUi();
      renderPayees(payees);
    });
  });
}

function applySelectionRange(payeeId, rowCheckboxes, startIndex, endIndex, checked) {
  const min = Math.min(startIndex, endIndex);
  const max = Math.max(startIndex, endIndex);

  for (let i = min; i <= max; i++) {
    const checkbox = rowCheckboxes[i];
    if (!checkbox) {
      continue;
    }
    checkbox.checked = checked;
    updateTransactionSelection(payeeId, checkbox.dataset.transactionId, checked);
  }
}

function updateTransactionSelection(payeeId, transactionId, isSelected) {
  const selectedIds = getSelectedTransactionIds(payeeId);

  if (isSelected) {
    selectedIds.add(transactionId);
  } else {
    selectedIds.delete(transactionId);
  }

  if (selectedIds.size === 0) {
    selectedTransactionIdsByPayee.delete(payeeId);
  }
}

function getSelectedTransactionIds(payeeId) {
  if (!selectedTransactionIdsByPayee.has(payeeId)) {
    selectedTransactionIdsByPayee.set(payeeId, new Set());
  }
  return selectedTransactionIdsByPayee.get(payeeId);
}

function selectPayee(payee) {
  const selectedIds = getSelectedTransactionIds(payee.payee);
  if (selectedIds.size === 0) {
    showError('Select at least one transaction from the payee list before categorizing.');
    return;
  }

  selectedPayee = payee;
  selectedCategory = null;

  selectedPayeeNameEl.textContent = payee.payeeName || payee.payee;
  transactionCountEl.textContent = `${selectedIds.size} selected uncategorized transactions${buildDateRangeLabel()}`;

  renderCategories();
  updateConfirmButtonState();

  document.querySelector('.section').style.display = 'none';
  categorySectionEl.style.display = 'block';
  successSectionEl.style.display = 'none';
}

function renderCategories() {
  categoryListEl.innerHTML = '';

  const sorted = [...categories].sort((a, b) => {
    if (a.name === 'Uncategorized') return -1;
    if (b.name === 'Uncategorized') return 1;
    return a.name.localeCompare(b.name);
  });

  sorted.forEach(category => {
    const item = document.createElement('label');
    item.className = 'category-item';
    item.innerHTML = `
      <input
        type="radio"
        name="category"
        value="${category.id}"
        data-name="${category.name}"
      >
      <span class="category-label">${escapeHtml(category.name)}</span>
    `;

    const radio = item.querySelector('input');
    radio.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedCategory = {
          id: category.id,
          name: category.name
        };

        document.querySelectorAll('.category-item').forEach(ci => {
          ci.classList.remove('selected');
        });
        item.classList.add('selected');
        updateConfirmButtonState();
      }
    });

    categoryListEl.appendChild(item);
  });
}

function updateConfirmButtonState() {
  if (!selectedPayee || !selectedCategory) {
    confirmBtnEl.disabled = true;
    return;
  }

  const selectedIds = getSelectedTransactionIds(selectedPayee.payee);
  confirmBtnEl.disabled = selectedIds.size === 0;
}

async function handleConfirm() {
  if (!selectedPayee || !selectedCategory) {
    showError('Please select a category');
    return;
  }

  const selectedIds = Array.from(getSelectedTransactionIds(selectedPayee.payee));
  if (selectedIds.length === 0) {
    showError('No transactions selected for this payee');
    return;
  }

  try {
    confirmBtnEl.disabled = true;
    confirmBtnEl.textContent = 'Updating...';

    const response = await fetch('/api/bulk-update-category', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        payee: selectedPayee.payee,
        categoryId: selectedCategory.id,
        transactionIds: selectedIds
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Update failed');
    }

    const result = await response.json();

    successMessageEl.textContent = `Successfully updated ${result.updatedCount} selected transactions for "${selectedPayee.payeeName || selectedPayee.payee}" to "${selectedCategory.name}"`;

    categorySectionEl.style.display = 'none';
    successSectionEl.style.display = 'block';

    // Clear local selection state for this payee, then refresh groups from server.
    selectedTransactionIdsByPayee.delete(selectedPayee.payee);
    expandedPayees.delete(selectedPayee.payee);
    transactionDetailsCache.clear();
    await loadPayees();
  } catch (error) {
    showError(`Failed to update: ${error.message}`);
    confirmBtnEl.disabled = false;
    confirmBtnEl.textContent = 'Update Transactions';
  }
}

function handleBack() {
  resetSelectionUi();
  renderPayees(payees);
}

function handleNext() {
  handleBack();
}

function resetSelectionUi() {
  selectedPayee = null;
  selectedCategory = null;
  confirmBtnEl.disabled = true;
  confirmBtnEl.textContent = 'Update Transactions';
  payeeSearchEl.value = '';
  expandedPayees.clear();
  transactionDetailsCache.clear();
  selectedTransactionIdsByPayee.clear();

  document.querySelector('.section').style.display = 'block';
  categorySectionEl.style.display = 'none';
  successSectionEl.style.display = 'none';
}

function buildDateRangeParams() {
  const params = new URLSearchParams();
  if (dateRange.startDate) {
    params.set('startDate', dateRange.startDate);
  }
  if (dateRange.endDate) {
    params.set('endDate', dateRange.endDate);
  }
  return params;
}

function buildDateRangeLabel() {
  if (dateRange.startDate && dateRange.endDate) {
    return ` in ${formatDate(dateRange.startDate)} - ${formatDate(dateRange.endDate)}`;
  }
  if (dateRange.startDate) {
    return ` from ${formatDate(dateRange.startDate)}`;
  }
  if (dateRange.endDate) {
    return ` up to ${formatDate(dateRange.endDate)}`;
  }
  return '';
}

function formatDate(dateString) {
  if (!dateString) {
    return '-';
  }

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return dateString;
  }

  return date.toLocaleDateString();
}

function formatAmount(amount) {
  const numeric = Number(amount || 0) / 100;
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function showLoading() {
  loadingEl.style.display = 'block';
  mainUiEl.style.display = 'none';
}

function hideLoading() {
  loadingEl.style.display = 'none';
  mainUiEl.style.display = 'block';
}

function showError(message) {
  hideLoading();
  errorEl.textContent = message;
  errorEl.style.display = 'block';
  setTimeout(() => {
    errorEl.style.display = 'none';
  }, 5000);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Start the app
init();
