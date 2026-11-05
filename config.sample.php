<?php
// ── Family Tree configuration (sample) ───────────────────────────────────────
// Copy this file to config.php and fill in your own values:
//
//     cp config.sample.php config.php
//
// config.php is git-ignored and blocked from the web by .htaccess.

return [
    // Password everyone uses to log in
    'password' => 'change-me',

    // Long random string used to sign auth tokens.
    // Generate one with: php -r "echo bin2hex(random_bytes(32));"
    'secret'   => 'replace-with-a-long-random-string',

    // Path to the SQLite database file. It is created automatically
    // (with its schema) on first use, so no starter database is needed.
    'db_path'  => __DIR__ . '/trees.db',
];
