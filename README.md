# Family Tree

A private, self-hosted family tree app. It's a single-page web app with a small PHP + SQLite backend, behind one shared password. It imports and exports GEDCOM, so it works alongside Ancestry, MyHeritage, FamilySearch, Gramps and most other genealogy programs.

There's no build step or framework, and the server side has no dependencies beyond PHP.

## Features

- **Multiple trees.** Create, import, rename and delete as many trees as you like. Each one is stored on the server and available from any device.
- **People and relationships.** Record names and nicknames, sex, a living flag, birth and death details, and extra events such as baptism, census, occupation and emigration. You can also add photo URLs, sources and notes, and link parents, partners, children and siblings.
- **Views**
  - **List:** a family-group view, plus a printable Family Group Sheet
  - **Ancestors:** a pedigree chart
  - **Descendants:** a chart you can export as SVG or PNG
  - **Hourglass:** ancestors and descendants together
  - **Fan:** a wheel chart of ancestors
  - **Timeline**
  - **Places**, **Surnames** and **Stats**, including a births/deaths per decade chart and pedigree collapse detection
  - **Map:** birth and death places geocoded via OpenStreetMap
- **Relationship finder.** Shows how two people are related, for example "3rd cousin twice removed", or the relationship from one person to everyone else.
- **Search and filters.** Filter by name, place, date or note, by sex, by birth-year range, and by blood relatives only. Also includes duplicate detection, record-completeness scores and a "surprise me" random person.
- **Import and export.** Import or merge GEDCOM files, import people from CSV, and export GEDCOM 7.0. Dates for living people are suppressed on export.
- **Keyboard shortcuts:** press `?` in the app to see the full list.
- **Undo** for the last add or edit, and conflict detection when the same tree is edited in two places.

## Requirements

- PHP 8.0+ with PDO SQLite (`pdo_sqlite`)
- Apache with `.htaccess` support (`AllowOverride All`), or any web server if you replicate the rules in [`.htaccess`](.htaccess)
- A modern browser. The Map view also needs internet access to load Leaflet, map tiles and geocoding.

## Setup

1. Copy the files to a directory your web server serves.
2. Create your config from the sample:

   ```bash
   cp config.sample.php config.php
   ```

3. Edit `config.php`:
   - `password`: the shared login password
   - `secret`: a long random string used to sign login tokens. Generate one with:

     ```bash
     php -r "echo bin2hex(random_bytes(32));"
     ```

   - `db_path`: where the SQLite database lives. It defaults to `trees.db` next to `api.php`.
4. Make sure the web server user can write to the directory containing the database. SQLite also creates `-wal` and `-shm` files beside it.

You don't need to create the database. `api.php` creates `trees.db` and its schema on the first request.

### Running locally

```bash
php -S localhost:8123
```

Then open <http://localhost:8123>. PHP's built-in server ignores `.htaccess`, so keep this to local use.

### Trying it out

[`demo/demo-family.ged`](demo/demo-family.ged) contains a small, entirely fictional three-generation family. Log in, click **Import GEDCOM…**, and choose that file.

## Deploying

- `.htaccess` blocks web access to `config.php`, `trees.db*` and `.env*`, disables directory listings, and passes the `Authorization` header through to PHP. Without that header, every API call would return 401 on CGI/FastCGI setups.
- Serve the site over **HTTPS**, since the password and login tokens are sent with every request.
- When you deploy changes to `app.js` or `style.css`, bump the `?v=` query string on their tags in `index.html` so browsers don't keep cached copies.
- `demo/` is harmless to publish, but you don't need to upload it.

## Backups

All your data is in the SQLite database (`trees.db` by default). To back it up, copy that file, or use **More → Export GEDCOM** in the app for each tree. If you copy the database while the app is in use, use SQLite's backup command so the `-wal` file is included:

```bash
sqlite3 trees.db ".backup trees-backup.db"
```

## Project structure

| File | Purpose |
| --- | --- |
| `index.html` | App shell, dialogs, user guide and Content Security Policy |
| `app.js` | The whole front end: GEDCOM parsing, views, charts and editing |
| `style.css` | Styles |
| `sheet.js` | Print button for the Family Group Sheet popup (kept separate because the CSP forbids inline scripts) |
| `api.php` | JSON API: auth, and list/get/create/update/delete trees |
| `config.sample.php` | Template for `config.php` |
| `.htaccess` | Apache access rules |
| `demo/demo-family.ged` | Fictional sample data |

### API

All endpoints are `api.php?action=…`. Everything except `auth` needs an `Authorization: Bearer <token>` header. Tokens expire after 10 days.

| Action | Method | Description |
| --- | --- | --- |
| `auth` | POST | `{ "password": "…" }` → `{ "token": "…" }` |
| `trees` | GET | List trees (metadata only) |
| `tree&id=N` | GET | One tree, including its GEDCOM |
| `create` | POST | Create a tree from `{ name, gedcom, person_count }` |
| `update&id=N` | POST | Save `{ name?, gedcom, person_count, base_modified? }`. Returns 409 if `base_modified` no longer matches, meaning the tree was changed elsewhere. |
| `delete&id=N` | POST | Delete a tree |

## Privacy

Real family data is never committed. `.gitignore` excludes `config.php`, `.env*`, every `*.ged` file outside `demo/`, and all SQLite and SQL files (`*.db`, `*.sqlite`, `*.sql`, backups). Keep exports and databases out of the repository.

## Licence

Family Tree is released under the [MIT License](LICENSE), © 2026 [Mark Duwe](https://duwe.co.uk). You can use, change and share it freely, including commercially, as long as you keep the copyright and licence notice in all copies or substantial portions of the code.
