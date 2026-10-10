# 72 Ventures Khata

A small web app for the 72 Ventures group: monthly share savings, member loans, a ledger, notices and rules.

- Every member has their own **login ID and password**.
- A member sees **only their own account**, plus the group totals, notices and rules.
- An **admin** sees and changes everything.
- Works in Nepali and English.

## 1. Try it on your own computer

You need Node.js version 18 or newer. There is nothing else to install.

```
cd 72-ventures-app
node server.js
```

The first time, the terminal shows a login ID (`admin`) and a password. Open http://localhost:3000, sign in, and set your own password.

## 2. First steps as admin

1. Open **Members**, edit the member called "Admin", and change the name to your own name.
2. Send your friends the web address. Each friend taps **First time here? Create your account** and chooses their own login ID and password.
3. Open **Members**. New accounts show under **Waiting for your approval**. Tap **Approve** for the people you know, and **Remove** for anyone else. A friend can sign in only after you approve them.
   You can also add a friend yourself with **Add member** and give them a login ID and a first password. The app then makes them choose their own password the first time they sign in.
4. Open **Settings** and check the first savings month and the rules.
5. Record payments on the **Monthly savings** tab by tapping a box.

To give a friend a new password, edit the member and type a new one. To make a second admin (for example the treasurer), set **Admin rights** to Yes.

In **Settings**, "Members can see the whole group record" is **No** at the start. Change it to Yes if the group wants every member to see everyone's savings and loans.

The **Change history** tab lists every change with the admin's name and the time. Only admins see it, and nobody can edit or delete it in the app.

## 3. Put it on the internet

Your friends can only use it when it runs on a server. Any host that runs Node.js works. The host must have:

- **HTTPS** (a web address that starts with `https://`). Without it, passwords travel unprotected.
- **A disk that keeps files.** All records live in one file, `data/db.json`. Some free hosts delete files on every restart, and your records would be lost.

Settings you can pass to the server:

| Name | What it does | Default |
|---|---|---|
| `PORT` | The port to listen on | 3000 |
| `DATA_DIR` | The folder for `db.json` and backups | `data` next to `server.js` |
| `ADMIN_PASSWORD` | The first admin password (first start only) | a random one, shown in the terminal |

Example on a Linux server:

```
PORT=3000 DATA_DIR=/var/lib/khata node server.js
```

Put a web server such as Caddy or Nginx in front of it for HTTPS, and use a tool such as `systemd` or `pm2` to keep it running.

## 4. Backups

The app copies the data to `data/backup-YYYY-MM-DD.json` once a day, before the first change of that day. Copy the `data` folder to another place from time to time. To restore, stop the server and replace `db.json` with a backup.

## 5. Forgot the admin password

Stop the server, then run:

```
node server.js --reset-admin
```

It shows a new password for the admin. Start the server again and sign in.

## How it keeps accounts safe

- Passwords are stored scrambled (scrypt). Nobody can read them, not even the admin.
- The server sends a member only their own records. The other members' data never reaches their browser.
- Only an admin account can change records. The server checks this on every change.
- After 8 wrong passwords, that login ID is locked for 15 minutes.
