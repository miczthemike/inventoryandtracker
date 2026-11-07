# Authentication and access

## First-time owner setup

1. Start the server on its Windows PC with `node .\servver.js`.
2. On that same PC, open `http://localhost:3000` and create the owner password for `miczthemike`.
   Owner setup is accepted only from a loopback connection and can only run once.
3. Keep the owner password private. It must be at least 12 characters.

Passwords are stored as salted scrypt hashes in `users.json`; the original passwords cannot be recovered. `users.json` is excluded from Git. Keep it with the server's persistent data, do not commit it, and include it in a protected backup. Restarting the server signs out active users.

## Roles

- **Owner (`miczthemike`)**: all application permissions and sole access to User Management. Can create accounts, change access, disable accounts, and issue temporary password resets.
- **Administrator**: all consumables, equipment, and analytics features. Cannot access User Management or reset another user's password.
- **Regular user**: can view consumables and submit requests. Cannot add consumables, manage stock, view equipment/status, or access analytics.
- **Custom access**: the owner can grant or revoke individual page and action permissions. Granting an action also enables access to its page.

New users receive a generated temporary password shown only once in User Management. Give it to the user securely; the account is required to set a new password at first sign-in. Users can change their own passwords while signed in.

Inventory creation, stock activity, item requests, and equipment activity record the signed-in username on the server. Legacy records created before this audit tracking was added display as "Not recorded".

## Network deployment

The app's built-in server uses HTTP by default. Before allowing sign-ins from other PCs, put it behind HTTPS so passwords and session cookies are protected in transit. If a trusted HTTPS reverse proxy forwards requests to Node, start the app with `TRUST_PROXY=true`; do not enable this unless requests can only reach Node through that trusted proxy. The session cookie is HTTP-only and uses the `Secure` attribute when Express detects HTTPS.
