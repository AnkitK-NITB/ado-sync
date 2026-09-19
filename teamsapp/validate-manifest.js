// Validates the Teams manifest against the published schema for its own
// manifestVersion. The schema sets additionalProperties:false at several
// levels, so an unknown key is a hard rejection at upload time -- which is
// exactly how "packageName" slipped through an eyeball check.
const fs = require("fs");
const path = require("path");
const https = require("https");

const manifestPath = path.join(__dirname, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
}

const problems = [];
const checked = [];

function checkObject(value, schema, pointer) {
  if (!schema || !schema.properties) return;
  const allowed = new Set(Object.keys(schema.properties));

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (key === "$schema" && pointer === "") continue;
      if (!allowed.has(key)) {
        problems.push(`${pointer || "(root)"}: "${key}" is not defined and additional properties are not allowed`);
      }
    }
  }
  for (const req of schema.required ?? []) {
    if (value[req] === undefined) problems.push(`${pointer || "(root)"}: missing required property "${req}"`);
  }

  for (const [key, sub] of Object.entries(schema.properties)) {
    const v = value[key];
    if (v === undefined) continue;
    const here = pointer ? `${pointer}.${key}` : key;
    checked.push(here);

    if (sub.enum && !Array.isArray(v) && !sub.enum.includes(v)) {
      problems.push(`${here}: "${v}" is not one of ${JSON.stringify(sub.enum)}`);
    }
    if (typeof v === "string") {
      if (sub.maxLength && v.length > sub.maxLength) {
        problems.push(`${here}: ${v.length} chars exceeds maxLength ${sub.maxLength}`);
      }
      if (sub.pattern && !new RegExp(sub.pattern).test(v)) {
        problems.push(`${here}: "${v}" does not match ${sub.pattern}`);
      }
    }
    if (Array.isArray(v) && sub.items) {
      v.forEach((entry, i) => {
        if (sub.items.enum && !sub.items.enum.includes(entry)) {
          problems.push(`${here}[${i}]: "${entry}" is not one of ${JSON.stringify(sub.items.enum)}`);
        }
        if (entry && typeof entry === "object") checkObject(entry, sub.items, `${here}[${i}]`);
      });
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      checkObject(v, sub, here);
    }
  }
}

(async () => {
  const url =
    manifest.$schema ||
    `https://developer.microsoft.com/en-us/json-schemas/teams/v${manifest.manifestVersion}/MicrosoftTeams.schema.json`;
  console.log(`manifestVersion ${manifest.manifestVersion}`);
  console.log(`schema ${url}\n`);

  const schema = await get(url);
  checkObject(manifest, schema, "");

  // The icon files themselves, which the schema cannot check.
  for (const [kind, expected] of [["color", 192], ["outline", 32]]) {
    const file = path.join(__dirname, manifest.icons[kind]);
    if (!fs.existsSync(file)) {
      problems.push(`icons.${kind}: ${manifest.icons[kind]} is missing`);
      continue;
    }
    const buf = fs.readFileSync(file);
    // PNG IHDR: width and height are big-endian uint32 at offsets 16 and 20.
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w !== expected || h !== expected) {
      problems.push(`icons.${kind}: ${w}x${h}, expected ${expected}x${expected}`);
    } else {
      console.log(`  icons.${kind}  ${w}x${h}  OK`);
    }
  }

  console.log(`\nchecked ${checked.length} properties`);
  if (problems.length === 0) {
    console.log("VALID — no schema problems found");
  } else {
    console.log(`INVALID — ${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  }
})();
