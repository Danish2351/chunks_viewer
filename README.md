# Chunks Viewer

A lightweight web-based audit viewer for PostgreSQL vector chunk stores (`public.documents`). It allows you to explore document chunks, filter by law family or section, inspect chunk metadata and content, and run vector similarity searches.

---

## Prerequisites

- [Node.js](https://nodejs.org/) (v16 or newer recommended)
- `ssh` client available in your terminal / system `PATH`
- SSH public key access to the remote database server

---

## 1. Environment Setup

Create an environment file by copying [.env.example](file:///home/danish/Downloads/db%20comparision/chunks-viewer%20(2)/.env.example) to `.env.server` (or `.env`):

```bash
cp .env.example .env.server
```

Configure the following variables in `.env.server`:

| Variable | Description | Value |
| :--- | :--- | :--- |
| `DB_SSH` | SSH target for the remote server | `<username>@<remote_host>` |
| `PGPASSWORD_SERVER` | Remote PostgreSQL user password | `<remote_db_password>` |
| `PGPORT_SERVER` | Local port allocated for the SSH tunnel | `<local_tunnel_port>` |
| `PGDATABASE_SERVER` | Target database name to inspect | `<database_name>` |
| `PGHOST_SERVER` | Local host address for PostgreSQL | `<local_host>` |

### Optional Variables
- `PORT`: HTTP port for the web viewer (defaults to `3000`).
- `HOST`: Bind address (defaults to `127.0.0.1`).
- `VIEWER_PASSWORD`: HTTP Basic Auth password (required if `HOST` is exposed beyond localhost).
- Local DB options: `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGPASSWORD` (if using `local-restore`).

---

## 2. First-Time Setup: SSH Key Configuration

> [!IMPORTANT]
> **The app creates and manages the SSH tunnel automatically** when it starts—you do **not** need to manually run `ssh -L ...` in a separate terminal.
>
> However, because the app spawns SSH in non-interactive batch mode (`BatchMode=yes`), **your machine's public SSH key must be saved in the remote server's `~/.ssh/authorized_keys` beforehand**.

### Step 1: Check or generate your SSH key
If you don't already have an SSH key pair on your machine, generate one:
```bash
ssh-keygen -t ed25519
```
*(Press Enter to accept default file location)*

### Step 2: Copy your public SSH key to the remote server
Use `ssh-copy-id` to install your key on the remote host:
```bash
ssh-copy-id <username>@<remote_host>
```

*Alternative (manual copy):*
```bash
cat ~/.ssh/id_ed25519.pub | ssh <username>@<remote_host> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

### Step 3: Verify passwordless SSH access
Ensure you can connect without being prompted for an SSH password:
```bash
ssh -o BatchMode=yes <username>@<remote_host> "echo SSH connection successful"
```

---

## 3. Running the Project

### 1. Install dependencies
```bash
npm install
```

### 2. Start the server
```bash
npm start
```
*(or `node server.js`)*

### 3. Open the viewer
Open your browser and navigate to:
```
http://localhost:3000
```

### What happens behind the scenes:
1. The app first probes a direct TCP connection to the remote PostgreSQL port.
2. If direct access is blocked by firewall/security group rules, it automatically spawns a background SSH tunnel forwarding `PGPORT_SERVER` to the remote DB.
3. Once running, you can inspect chunk contents, query vectors, and switch between configured database targets.
4. When you stop the server (<kbd>Ctrl</kbd> + <kbd>C</kbd>), the SSH tunnel process is cleanly terminated automatically.
