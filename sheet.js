// Wires up the print button on the Family Group Sheet popup.
// Lives in its own file because the sheet is a blob: document that inherits
// the app's CSP, which forbids inline scripts and inline event handlers.
document.getElementById('sheet-print-btn').addEventListener('click', () => window.print());
