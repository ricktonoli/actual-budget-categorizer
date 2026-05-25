# Actual Budget Transaction Categorizer

Web UI for reviewing uncategorized Actual Budget transactions grouped by payee, selecting specific transactions, and applying a category in bulk.

## Features

- Group uncategorized transactions by payee
- Filter payee groups by date range (`From` / `To`)
- Expand a payee to view its transactions
- Select transactions individually, by row click, select-all, or shift-click range
- Sort transaction columns by clicking headers (`Date`, `Amount`, `Notes`)
- Apply a category to only the selected transactions
- Local-first workflow (browser + local Node server)

## Requirements

- Node.js 16+
- Access to an Actual Budget server
- Actual Budget credentials:
   - account password
   - encryption password (if your budget uses encryption)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create and configure `.env`:

```bash
cp .env.example .env
```

Example `.env`:

```env
AB_SERVER=your-actual-host
AB_PORT=5006
AB_USE_HTTPS=true
AB_PASSWORD=your_password
AB_ENCRYPTION_PASSWORD=your_encryption_password
AB_SYNC_ID=your_budget_sync_id
AB_DATA_DIR=.actual-data
PORT=3001
```

Notes:

- If startup says no local budget is found, set `AB_SYNC_ID` (from Actual Budget settings -> Advanced -> Sync ID).
- In non-production mode, self-signed HTTPS certs are tolerated for local/network use.

3. Start the app:

```bash
npm start
```

4. Open:

- `http://localhost:3001`

## Usage

1. Set optional `From` / `To` dates to scope payee groups.
2. Search and expand payees to inspect transactions.
3. Select the transactions you want to categorize.
4. Click `Categorize selected` for a payee.
5. Choose a category and click `Update Transactions`.
6. Click `Done` to return to the payee list.

## API

- `GET /api/payees`
   - Returns payees with uncategorized transaction counts
   - Optional query params: `startDate`, `endDate` (`YYYY-MM-DD`)

- `GET /api/categories`
   - Returns available categories

- `GET /api/transactions/:payee`
   - Returns uncategorized transactions for a payee
   - Optional query params: `startDate`, `endDate` (`YYYY-MM-DD`)

- `POST /api/bulk-update-category`
   - Updates selected uncategorized transactions for a payee
   - Body:
      - `payee` (required)
      - `categoryId` (required)
      - `transactionIds` (optional, non-empty array; when provided, only these are updated)

- `GET /api/health`
   - Basic health status

## Troubleshooting

- Connection/auth errors:
   - Verify `AB_SERVER`, `AB_PORT`, `AB_USE_HTTPS`, `AB_PASSWORD`, and `AB_ENCRYPTION_PASSWORD`.

- No budget found locally:
   - Set `AB_SYNC_ID` and restart.

- Port conflict:
   - Change `PORT` in `.env`.

## Development

```bash
npx nodemon server.js
```

## License

MIT
