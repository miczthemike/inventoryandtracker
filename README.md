# PROXY Plus IT Inventory & Equipment Tracker

Web application for tracking consumable stock, requests, IT equipment deployments, returns, IT jobs, equipment activity, and inventory reports.

## Features

- Consumable inventory with photos, low-stock thresholds, and stock adjustments.
- Consumable requests with requestor and department tracking.
- Creator and processor attribution for consumable and equipment records, stock activity, requests, deployments, returns, and maintenance.
- Equipment inventory, deployment and return history, due dates, maintenance, and status tracking.
- Workbook-based IT asset register for network/computer devices, televisions, telephones, CCTV, and locksets, with searchable, sortable lists, persistent add/edit/delete controls, and printable reports.
- Shared IT jobs board with filing details, priorities, follow-up dates, assignment, overdue reminders, and status history.
- Search, filtering, analytics, date-range reports, and CSV export.
- Live updates for signed-in users connected to the same server.
- Owner-managed user accounts, roles, and page/action permissions.

## Requirements

- Windows PC running a supported Node.js LTS release.
- Git, if you plan to deploy updates from GitHub.

## Run locally

Open PowerShell in the project folder:

```powershell
npm install
node .\servver.js
```

By default, the server listens on port `3000`. To use another port:

```powershell
$env:PORT = "3001"
node .\servver.js
```

Open `http://localhost:3000` (or your selected port) in a browser. Keep the PowerShell window running while the server is in use.

## Start automatically on Windows

Use Windows Task Scheduler rather than the Startup folder so the server can start after a reboot even when nobody signs in:

1. Open **Task Scheduler** and select **Create Task**.
2. On **General**, give it a name such as `IT Inventory Server` and select **Run whether user is logged on or not**. Use an account that can access this project folder.
3. On **Triggers**, add **At startup**.
4. On **Actions**, add **Start a program**. Set **Program/script** to `C:\Windows\System32\cmd.exe`, **Add arguments** to `/c "C:\path\to\project\start-server.bat"` (replace the example with the actual path), and **Start in** to this project folder.
5. On **Settings**, enable **Restart the task if it fails** and choose a restart delay, such as 1 minute.
6. Save the task and enter the Windows account password if prompted. Right-click the task and select **Run** to test it.

The batch file starts `servver.js` from the project folder and reports a non-zero server exit to Task Scheduler. Node.js must be installed and available on the system `PATH`. Keep this project folder and its data files in place. The scheduled task runs the server as the selected Windows account; ensure that account has permission to read and write the project folder, including `db.json`, `users.json`, and `uploads\`.

## First-time owner setup

1. Start the server on the Windows server PC.
2. On that same PC, open `http://localhost:3000/login.html`.
3. Create the password for the owner account **miczthemike**. The first owner setup is allowed only from the server PC and only while no accounts exist.
4. Choose a strong password of at least 12 characters.
5. After setup, sign in as the owner and use **User Management** to create accounts.

Passwords are stored as salted scrypt hashes; the original password is not stored. New users receive a generated temporary password that is shown once. Share it securely with the user; they must choose a new password at first sign-in.

See [AUTHENTICATION.md](./AUTHENTICATION.md) for role, access, password, and HTTPS details.

## Roles

| Role | Access |
|---|---|
| Owner (`miczthemike`) | All application features and the only role that can access User Management, change users' access, disable accounts, or issue temporary password resets. |
| Administrator | Consumables, equipment, and analytics features. Cannot access User Management or reset other users' passwords. |
| Regular user | View consumables and submit requests. Cannot add consumables, manage stock, view equipment/status, or access analytics. |
| Custom access | Owner-selected page and action permissions. |

The server checks permissions on API requests as well as hiding unavailable pages and controls in the browser.
Users with the `equipmentManage` permission can add, edit, and delete asset-register records. Register changes are stored in `db.json` and included in the database backups.

All signed-in users can file and view IT jobs. Only the owner and administrators can change a job's status; each status update records who changed it, when, and an optional progress note.

## Data and backups

The application stores its data beside `servver.js`:

- `db.json`: inventory, requests, equipment, the IT asset register, IT jobs, and activity.
- `users.json`: account records and password hashes.
- `uploads\`: uploaded inventory/equipment photos.
- `db.bak.json` and `backups\`: database recovery copies.

These files and folders are excluded from Git. **Do not commit `users.json`, database files, backups, or uploads.** Back them up securely, and keep the latest backup outside the server PC as well. To move or update the app, preserve the server's data and uploads; do not replace them with empty local copies.

Restarting the Node.js server ends active sessions. Users will need to sign in again.

## Update from GitHub

Commit and push code changes from the development PC:

```powershell
git add .
git commit -m "Describe the update"
git push origin main
```

On the server PC, stop the running Node process, make a protected backup of the data listed above, then pull the update:

```powershell
git pull origin main
npm install
node .\servver.js
```

Run these commands from the existing server clone. Do not initialize a new empty database or replace the server's `users.json`, `db.json`, backups, or uploads with files from the development PC. If dependencies have not changed, `npm install` is still safe but usually not necessary.

## Network security

The built-in server uses HTTP. Before users sign in from other PCs, put the app behind HTTPS so passwords and session cookies are protected in transit. If using a trusted HTTPS reverse proxy, set `TRUST_PROXY=true` only when Node can be reached exclusively through that proxy.

The sign-in page uses same-origin scripts and a restrictive Content Security Policy. The main application uses Tailwind CSS and Chart.js from public CDNs.

## Project files

- `servver.js`: Express server, file-backed data store, authentication, and API routes.
- `public\index.html`: inventory application UI.
- `public\script.js`: application behavior and live updates.
- `public\login.html` and `public\login.js`: setup, sign-in, and password-change screens.
- `.gitignore`: excludes server data, uploaded files, backups, and dependencies.

There is currently no automated test suite configured in `package.json`.
