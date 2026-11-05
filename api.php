<?php
// ── Family Tree API ───────────────────────────────────────────────────────────
// Single-file PHP backend. Works on any Apache host with PHP 8.0+ and PDO/SQLite.

header('Content-Type: application/json; charset=utf-8');
// ── Security headers ──────────────────────────────────────────────────────────
header('X-Content-Type-Options: nosniff');          // prevent MIME-sniffing
header('X-Frame-Options: DENY');                    // prevent clickjacking
header('Referrer-Policy: strict-origin-when-cross-origin');
header('Permissions-Policy: interest-cohort=()');   // opt-out of FLoC/Topics

// ── Config ────────────────────────────────────────────────────────────────────
$cfg = require __DIR__ . '/config.php';
$SITE_PASSWORD = $cfg['password'];
$SECRET        = $cfg['secret'];
$DB_PATH       = $cfg['db_path'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function respond($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

// Tokens are "<expiry>.<hmac(expiry)>" so they expire server-side (10 days,
// matching the client cookie lifetime) and never embed the password.
const TOKEN_TTL = 10 * 86400;

function makeToken($secret) {
    $exp = time() + TOKEN_TTL;
    return $exp . '.' . hash_hmac('sha256', (string)$exp, $secret);
}

function requireAuth($secret) {
    $hdr = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!str_starts_with($hdr, 'Bearer ')) respond(['error' => 'Unauthorized'], 401);
    $token = substr($hdr, 7);
    $dot = strpos($token, '.');
    if ($dot === false) respond(['error' => 'Unauthorized'], 401);
    $exp = substr($token, 0, $dot);
    $sig = substr($token, $dot + 1);
    if (!ctype_digit($exp)) respond(['error' => 'Unauthorized'], 401);
    if (!hash_equals(hash_hmac('sha256', $exp, $secret), $sig)) respond(['error' => 'Unauthorized'], 401);
    if ((int)$exp < time()) respond(['error' => 'Session expired'], 401);
}

function getDB($path) {
    try {
        $db = new PDO('sqlite:' . $path);
    } catch (Exception $e) {
        respond(['error' => 'Database unavailable: ' . $e->getMessage()], 500);
    }
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $db->exec('PRAGMA journal_mode=WAL');
    $db->exec('CREATE TABLE IF NOT EXISTS trees (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL,
        gedcom       TEXT    NOT NULL DEFAULT \'\',
        person_count INTEGER NOT NULL DEFAULT 0,
        created      INTEGER NOT NULL DEFAULT 0,
        modified     INTEGER NOT NULL DEFAULT 0
    )');
    return $db;
}

function now_ms() {
    return (int)(microtime(true) * 1000);
}


// ── Route ─────────────────────────────────────────────────────────────────────
$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];

// Reject suspiciously large payloads early (50 MB limit)
$raw = file_get_contents('php://input', false, null, 0, 52_428_800);
if (strlen($raw) >= 52_428_800) respond(['error' => 'Payload too large'], 413);
$body = json_decode($raw, true) ?? [];

// Auth — no token needed
if ($action === 'auth' && $method === 'POST') {
    $pw = $body['password'] ?? '';
    if (!hash_equals($SITE_PASSWORD, (string)$pw)) respond(['error' => 'Wrong password'], 401);
    respond(['token' => makeToken($SECRET)]);
}


// Everything else requires a valid token
requireAuth($SECRET);
$db = getDB($DB_PATH);

// Mutating actions must be POST — a stray GET to action=update would
// overwrite the tree with the (empty) request body.
if (in_array($action, ['create', 'update', 'delete'], true) && $method !== 'POST') {
    respond(['error' => 'Method not allowed'], 405);
}

switch ($action) {

    case 'trees': // GET — list all trees (no gedcom payload, just metadata)
        $rows = $db->query('SELECT id, name, person_count, created, modified FROM trees ORDER BY modified DESC')->fetchAll();
        respond($rows);

    case 'tree': // GET — full tree including gedcom
        $id = (int)($_GET['id'] ?? 0);
        $row = $db->prepare('SELECT * FROM trees WHERE id=?');
        $row->execute([$id]);
        $tree = $row->fetch();
        if (!$tree) respond(['error' => 'Not found'], 404);
        respond($tree);

    case 'create': // POST — new tree
        $now  = now_ms();
        $stmt = $db->prepare('INSERT INTO trees (name, gedcom, person_count, created, modified) VALUES (?,?,?,?,?)');
        $stmt->execute([
            $body['name']         ?? 'Untitled',
            $body['gedcom']       ?? '',
            (int)($body['person_count'] ?? 0),
            (int)($body['created']      ?? $now),
            (int)($body['modified']     ?? $now),
        ]);
        respond(['id' => (int)$db->lastInsertId()]);

    case 'update': // POST — update existing tree
        $id = (int)($_GET['id'] ?? 0);
        // A missing/garbled body must never blank a tree
        if (!is_string($body['gedcom'] ?? null) || $body['gedcom'] === '') respond(['error' => 'Missing tree data'], 400);
        $sql    = 'UPDATE trees SET name=COALESCE(?, name), gedcom=?, person_count=?, modified=? WHERE id=?';
        $params = [
            isset($body['name']) && $body['name'] !== '' ? (string)$body['name'] : null,
            $body['gedcom'],
            (int)($body['person_count'] ?? 0),
            (int)($body['modified']     ?? now_ms()),
            $id,
        ];
        // Optimistic locking: only save if nobody else has saved since this
        // client last loaded/saved (base_modified). Otherwise answer 409 so the
        // client can ask the user instead of silently overwriting their edits.
        if (isset($body['base_modified'])) {
            $sql     .= ' AND modified=?';
            $params[] = (int)$body['base_modified'];
        }
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        if ($stmt->rowCount() === 0) {
            $chk = $db->prepare('SELECT modified FROM trees WHERE id=?');
            $chk->execute([$id]);
            $row = $chk->fetch();
            if (!$row) respond(['error' => 'Not found'], 404);
            respond(['error' => 'Changed elsewhere', 'modified' => (int)$row['modified']], 409);
        }
        respond(['ok' => true]);

    case 'delete': // POST — delete tree
        $id = (int)($_GET['id'] ?? 0);
        $db->prepare('DELETE FROM trees WHERE id=?')->execute([$id]);
        respond(['ok' => true]);

    default:
        respond(['error' => 'Unknown action'], 400);
}
