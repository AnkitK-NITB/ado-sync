// Refreshes data/live-workitems.json from Azure DevOps.
//
// Fetches with $expand=Relations so parentId and childIds are populated -- the
// hierarchy rule in match.ts reads those, and without them it is inert.
//
// Authenticates as the signed-in user with a short-lived Microsoft Entra token
// from the Azure CLI. No personal access token.
//
//   node tools/fetch-workitems.js [--project Engineering] [--identity you@example.com] [--top 60]
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFile } = require("child_process");

const AGENT = path.join(__dirname, "..");
const DATA = path.join(AGENT, "data");
const { toWorkItems, missingChildren } = require(path.join(AGENT, "out", "adoMap.js"));

const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const enrollment = JSON.parse(fs.readFileSync(path.join(DATA, "enrollment.json"), "utf8"));
const ORG = arg("org", "contoso");
const PROJECT = arg("project", "Engineering");
const IDENTITY = arg("identity", enrollment.enrolled[0].adoIdentity);
const TOP = parseInt(arg("top", "60"), 10);

function token() {
  return new Promise((resolve, reject) => {
    execFile(
      process.env.ComSpec || "cmd.exe",
      ["/c", "az", "account", "get-access-token", "--resource", ADO_RESOURCE, "-o", "json"],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error("no Azure DevOps token — run 'az login'. " + (stderr || err.message)));
        try { resolve(JSON.parse(stdout).accessToken); }
        catch (e) { reject(e); }
      }
    );
  });
}

function request(method, urlPath, body, tok) {
  const payload = body ? JSON.stringify(body) : null;
  const headers = { Authorization: "Bearer " + tok };
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = https.request({ method, hostname: "dev.azure.com", path: urlPath, headers }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error("HTTP " + res.statusCode + ": " + t.slice(0, 400)));
        try { resolve(JSON.parse(t)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const tok = await token();

  const wiql = {
    query:
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '" + PROJECT +
      "' AND [System.AssignedTo] = '" + IDENTITY.replace(/'/g, "''") +
      "' AND [System.State] <> 'Removed' ORDER BY [System.ChangedDate] DESC",
  };
  const found = await request("POST", `/${ORG}/${PROJECT}/_apis/wit/wiql?api-version=7.1&$top=${TOP}`, wiql, tok);
  const ids = (found.workItems || []).map((w) => w.id).slice(0, TOP);
  if (ids.length === 0) {
    console.error("No work items assigned to " + IDENTITY + " in " + PROJECT + ".");
    process.exit(1);
  }

  // Relations cannot be combined with a field list, so ask for everything and
  // let adoMap pick out what the engine needs.
  async function fetchBatch(batchIds) {
    const out = [];
    for (let i = 0; i < batchIds.length; i += 200) {
      const batch = await request(
        "POST",
        `/${ORG}/${PROJECT}/_apis/wit/workitemsbatch?api-version=7.1`,
        { ids: batchIds.slice(i, i + 200), $expand: "Relations" },
        tok
      );
      out.push(...(batch.value || []));
    }
    return out;
  }

  const raw = await fetchBatch(ids);

  // The query above only returns items assigned to you, so anything you link to
  // but do not own is absent. The linked tier in match.ts looks those items up
  // by id, so without this second pass it can never fire on live data. One hop
  // only, matching the traversal depth the engine allows.
  const owned = toWorkItems(raw);
  const present = new Set(owned.map((i) => i.id));
  const reach = new Set();
  for (const i of owned) {
    for (const r of i.relatedIds || []) if (!present.has(r)) reach.add(r);
    for (const c of i.childIds || []) if (!present.has(c)) reach.add(c);
  }
  const neighbourRaw = reach.size ? await fetchBatch([...reach]) : [];
  raw.push(...neighbourRaw);

  const items = toWorkItems(raw);
  const missing = missingChildren(items);

  const out = {
    capturedAt: new Date().toISOString(),
    org: ORG,
    project: PROJECT,
    areaPath: "",
    source: "tools/fetch-workitems.js — WIQL + workitemsbatch with $expand=Relations",
    identity: IDENTITY,
    items,
  };
  fs.writeFileSync(path.join(DATA, "live-workitems.json"), JSON.stringify(out, null, 2));

  const withKids = items.filter((i) => (i.childIds || []).length > 0).length;
  const withLinks = items.filter((i) => (i.relatedIds || []).length > 0).length;
  console.log(items.length + " work items written to data/live-workitems.json");
  console.log("  " + owned.length + " assigned to you, " + neighbourRaw.length + " pulled in by link");
  console.log("  " + withKids + " have children captured, " + withLinks + " have related links");
  if (missing.length) {
    // Distinctiveness is measured against the siblings present, so a partial
    // capture makes a child's words look more distinctive than they are.
    console.log("  " + missing.length + " child item(s) referenced but not fetched: " +
      missing.slice(0, 10).join(", ") + (missing.length > 10 ? " …" : ""));
    console.log("  Raise --top to pull them in, or accept that hierarchy is partial.");
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
