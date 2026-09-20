export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1)
    .filter((values) => values.some((value) => value !== ''))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, (values[index] ?? '').trim()])));
}

export function parseParkCsv(text, updatedAt = new Date().toISOString()) {
  const parks = parseCsv(text).map((park) => ({
    reference: park.reference,
    name: park.name,
    active: park.active,
    entityId: park.entityId,
    locationDesc: park.locationDesc,
    latitude: Number(park.latitude),
    longitude: Number(park.longitude),
    grid: park.grid,
  })).filter((park) => park.reference && Number.isFinite(park.latitude) && Number.isFinite(park.longitude));

  if (parks.length === 0) throw new Error('POTA park CSV contained no parks with coordinates');
  return { parks, updatedAt };
}
