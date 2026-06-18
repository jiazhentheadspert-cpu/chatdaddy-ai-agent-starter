const SHEET_NAME = 'AI Reply Log';
const HEADERS = [
  'created_at',
  'project_key',
  'case_id',
  'contact_name',
  'contact_phone',
  'customer_message',
  'ai_reply',
  'intent',
  'risk',
  'stage',
  'action',
  'send_status',
  'reason'
];

function doGet() {
  ensureSheet_();
  return json_({ ok: true, message: 'AI Reply Log is ready.' });
}

function doPost(e) {
  const secret = PropertiesService.getScriptProperties().getProperty('CTG_SHEET_SECRET');
  const incomingSecret = e && e.parameter && e.parameter.secret;

  if (!secret || incomingSecret !== secret) {
    return json_({ ok: false, error: 'Invalid secret' }, 403);
  }

  const body = JSON.parse(e.postData.contents || '{}');
  const sheet = ensureSheet_();

  sheet.appendRow(HEADERS.map(function (key) {
    return body[key] || '';
  }));

  return json_({ ok: true });
}

function ensureSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  const firstRow = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const isEmpty = firstRow.every(function (value) { return !value; });
  if (isEmpty) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function json_(data, status) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
