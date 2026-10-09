# NCGG Attendance Dashboard

## Cloud deployment (Supabase + Render)

The Render-hosted dashboard and its Supabase PostgreSQL database are shared by every device using the same dashboard URL. The staff API checks guild-ID/password sessions on the server. Members can view the public dashboard and check in without an account.

### 1. Set up Supabase

1. Create a Supabase project and keep its database password private.
2. In the Supabase SQL Editor, run [`supabase/setup.sql`](./supabase/setup.sql). It creates the dashboard tables and denies direct table access to Supabase's `anon` and `authenticated` API roles. The Node server connects directly using the server-only PostgreSQL connection string.
3. Before deploying the web service, import the current local roster, events, check-ins, and point history into the empty Supabase tables:

   ```powershell
   $env:DATABASE_URL = "your Supabase PostgreSQL connection string"
   $env:PGSSLROOTCERT = "C:\path\to\the\Supabase-ca-certificate.crt"
   npm.cmd run migrate:cloud
   ```

   The `PGSSLROOTCERT` setting is only needed if Node reports a certificate-chain error. Download the CA certificate from your Supabase project's **Database → SSL Configuration**, save it locally, and set the variable to that file's path; certificate validation remains enabled. The migration refuses to merge into non-empty cloud tables. It does not copy passwords; the first executive password is configured during deployment, then that executive creates passwords for other staff in the dashboard.

### 2. Deploy the web app to Render

1. In Render, create a Blueprint from this repository using [`render.yaml`](./render.yaml), or create a Node web service with build command `npm ci --omit=optional` and start command `npm start`. SQLite is an optional dependency for local/Electron use; Render omits it because the hosted service uses PostgreSQL.
2. Set these service environment variables in Render's dashboard:
   - `DATABASE_URL`: the Supabase PostgreSQL connection string. Use a Supabase session-mode connection string suitable for a persistent Node service.
   - `BOOTSTRAP_GUILD_ID`: the guild ID of an Executive already in the imported roster.
   - `BOOTSTRAP_PASSWORD`: a temporary password of at least 12 characters for that executive.
   - `SESSION_SECRET`: a random secret of at least 32 characters. Render can generate one.
   - `READER_BRIDGE_TOKEN`: a random secret of at least 32 characters, only needed for a remote PC/SC reader bridge.
3. Deploy, then open the Render URL from each device. Do not put the Supabase connection string, bootstrap password, or reader token in frontend code or commit them to the repository.
4. Sign in as the bootstrap executive. In **Member database**, add staff with their guild IDs, then use **Set staff password** to issue their initial passwords. Staff may manage events and attendance according to their server-enforced roles. Public visitors can only view the dashboard and submit member check-ins.
5. Remove or rotate the bootstrap password after staff accounts are configured. Keep `SESSION_SECRET` stable between deploys so active sessions remain valid.

Render's included Blueprint uses its Singapore region and free web-service plan. Free-tier services may sleep when idle; choose an always-on plan if you need the dashboard to respond without a wake-up delay. Supabase or hosting usage can change with provider plan choices.

## NFC reader on the cloud dashboard

Keyboard-wedge readers can scan directly into **NFC check-in** in the hosted page. For a PC/SC reader, the desktop app can load the cloud URL and run the Java bridge locally. Set `DASHBOARD_URL` to the Render HTTPS URL and set `NFC_BRIDGE_TOKEN` on the reader computer to the same secret configured as `READER_BRIDGE_TOKEN` in Render, then start the desktop app. Keep that reader token private and keep a staff session signed in on the reader kiosk so it can receive scans; members do not need their own accounts. Java 11 or newer is used if already installed; otherwise the desktop app downloads and verifies a Java 21 runtime on first launch. The reader still requires its Windows smart-card driver/service.

### Offline desktop check-ins

The desktop app caches its app shell, the latest events and attendance, and the full member roster (including NFC UIDs) after an Officer or Executive signs in to the desktop app while online. This roster is stored in the desktop browser profile on that computer. When the internet is unavailable, select a cached open event and scan using either the PC/SC reader or keyboard-wedge input; check-ins are queued on that device and submitted to the cloud when connectivity returns. Keep the app open while the queue syncs. Cards and events missing from the cache cannot be queued. The cloud remains authoritative: a closed event is rejected, and a check-in already recorded elsewhere is treated as already recorded rather than awarding points twice. Offline dashboard data may be stale, and member/event/point management is not available offline. Each reader computer must go online and sign in to the desktop app once to cache the current roster and events before it can work offline. The cache and queued check-ins remain on that computer and should only be used on trusted devices.

## Local development

Without `DATABASE_URL`, `npm.cmd start` and `npm.cmd run desktop` use a local SQLite database. Run `npm.cmd install` first. Local mode remains useful for development, but it does not synchronize data between devices. To create local officer accounts for testing, configure `BOOTSTRAP_GUILD_ID` and `BOOTSTRAP_PASSWORD` for an existing Executive row before the first start:

```powershell
$env:BOOTSTRAP_GUILD_ID = "the executive's guild ID"
$env:BOOTSTRAP_PASSWORD = "a temporary password of at least 12 characters"
npm.cmd run desktop
```

The `npm.cmd run reader` command compiles and starts the bridge for the local dashboard at `http://127.0.0.1:3000`. For the standalone Windows installer, run `npm.cmd run dist`; it builds the Java bridge and writes the NSIS installer to `dist`.

## Security and behavior notes

- Staff passwords are stored as salted scrypt hashes. The server issues HttpOnly, SameSite cookies and checks the current staff role on protected API requests. Login attempts are rate-limited.
- Public roster responses omit NFC UIDs. NFC UIDs are still used to perform unauthenticated check-ins as requested; a public check-in service cannot prove that a submitted UID came from a physical card, so protect the dashboard URL and monitor attendance for abuse.
- Member/officer/executive role labels and all staff permissions are checked server-side; request-body role values are not trusted.
- Officers and Executives can adjust points with a reason. Only Executives can close events or assign staff passwords. Members have no sign-in credentials.
- The local SQLite database bundled with the Windows installer contains roster names and NFC UIDs. Distribute it only to authorized users.
