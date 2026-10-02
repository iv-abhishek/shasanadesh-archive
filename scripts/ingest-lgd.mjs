#!/usr/bin/env node
/**
 * Pipeline stage: reference data (Local Government Directory)
 *
 * Purpose:
 *   States/UTs and districts with their LGD codes, from the Ministry of
 *   Panchayati Raj's Local Government Directory web service
 *   (lgdirectory.gov.in/webservices/lgdws). Profiles store the LGD codes, so a
 *   district officer's profile survives renames (Allahabad → Prayagraj) and
 *   matches other government systems that use the same codes.
 *     npm run ingest:lgd
 *     npm run ingest:lgd -- --refresh-days 30   (skip if the copy is newer)
 *
 * Output: datasets/lgd/lgd-states-districts.json (committed; public data).
 *   Hindi names and former names of UP districts come from
 *   datasets/lgd/district-names-up.json (LGD's "local name" for UP is English).
 *
 * Invariants:
 *   - only https://lgdirectory.gov.in, the public web service (no key, no
 *     CAPTCHA); robots.txt honoured; at least CRAWL_DELAY_MS (min 3 s)
 *     between requests; about 37 requests, two minutes
 *   - the file is replaced only when every state's districts were read
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";

const HOST = "lgdirectory.gov.in";
const BASE = `https://${HOST}/webservices/lgdws`;
const OUT = path.resolve("datasets/lgd/lgd-states-districts.json");
const NAMES_UP = path.resolve("datasets/lgd/district-names-up.json");
const UA =
  process.env.CRAWLER_USER_AGENT?.trim() ||
  "ShasanadeshArchiveBot/0.1 (research archive of government orders; contact via project owner)";
const DELAY = Math.max(3000, Number(process.env.CRAWL_DELAY_MS) || 3000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let last = 0;

async function robotsAllowsWebservices() {
  const response = await fetch(`https://${HOST}/robots.txt`, { headers: { "user-agent": UA } });
  if (!response.ok) return true; // no robots.txt: nothing disallowed
  let applies = false;
  for (const raw of (await response.text()).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (/^user-agent$/i.test(key)) applies = value === "*" || UA.toLowerCase().includes(value.toLowerCase());
    else if (applies && /^disallow$/i.test(key) && value && "/webservices/lgdws/".startsWith(value)) return false;
  }
  return true;
}

async function post(endpoint, form) {
  const wait = last + DELAY - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  const url = new URL(`${BASE}/${endpoint}`);
  if (url.hostname !== HOST || url.protocol !== "https:") throw new Error(`refusing ${url.href}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error("unexpected response (not a list)");
      return data;
    } catch (error) {
      if (attempt === 3) throw new Error(`${endpoint} ${JSON.stringify(form)}: ${error.message}`);
      await sleep(10_000 * attempt);
    }
  }
}

const clean = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value ?? null);
// "Jammu And Kashmir" → "Jammu and Kashmir"; LGD capitalises every word.
const titleName = (value) => clean(value).replace(/ (And|Of|The) /g, (word) => word.toLowerCase());
// LGD's local name is often the English name in capitals; keep it only when it is in an Indian script.
const localName = (value, english) => {
  const local = clean(value);
  return local && !/^[A-Za-z0-9 .,&()'-]+$/.test(local) && local !== english ? local : null;
};

function refreshDays() {
  const index = process.argv.indexOf("--refresh-days");
  if (index < 0) return 0;
  const days = Number(process.argv[index + 1]);
  if (!Number.isFinite(days) || days < 0) throw new Error("--refresh-days needs a number of days");
  return days;
}

async function main() {
  const days = refreshDays();
  if (days > 0) {
    try {
      const fetchedAt = Date.parse(JSON.parse(readFileSync(OUT, "utf8")).fetchedAt);
      if (Date.now() - fetchedAt < days * 86_400_000) {
        console.log(`SKIP LGD: read ${new Date(fetchedAt).toISOString().slice(0, 10)} (within ${days} days)`);
        return;
      }
    } catch {
      // No readable copy yet: fetch it.
    }
  }
  if (!(await robotsAllowsWebservices())) throw new Error(`robots.txt on ${HOST} disallows the web service`);
  const extraUp = JSON.parse(readFileSync(NAMES_UP, "utf8")).districts;

  const states = await post("stateList", {});
  if (states.length < 30) throw new Error(`only ${states.length} states returned`);
  const out = [];
  for (const state of states.sort((a, b) => a.stateCode - b.stateCode)) {
    const en = titleName(state.stateNameEnglish);
    const districts = await post("districtList", { stateCode: String(state.stateCode) });
    if (!districts.length) throw new Error(`${en}: no districts returned`);
    out.push({
      code: state.stateCode,
      name: en,
      local: localName(state.stateNameLocal, en),
      census2011Code: clean(state.census2011Code),
      districts: districts
        .map((district) => {
          const name = clean(district.districtNameEnglish);
          const extra = state.stateCode === 9 ? extraUp[String(district.districtCode)] : undefined;
          return {
            code: district.districtCode,
            name,
            local: localName(district.districtNameLocal, name),
            ...(extra ? { hi: extra.hi, hiSource: extra.hiSource, aliases: extra.aliases } : {}),
            census2011Code: clean(district.census2011Code),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "en")),
    });
    console.log(`  ${en}: ${districts.length} districts`);
  }

  const total = out.reduce((sum, state) => sum + state.districts.length, 0);
  const document = {
    _about:
      "States/UTs and districts with LGD codes from the Local Government Directory, Ministry of Panchayati Raj (https://lgdirectory.gov.in). Regenerate with npm run ingest:lgd. 'local' is LGD's local-language name when it is in an Indian script; UP districts also carry 'hi' and former names ('aliases') from datasets/lgd/district-names-up.json.",
    source: "https://lgdirectory.gov.in/webservices/lgdws",
    fetchedAt: new Date().toISOString(),
    stateCount: out.length,
    districtCount: total,
    states: out,
  };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(`${OUT}.tmp`, JSON.stringify(document, null, 1) + "\n");
  renameSync(`${OUT}.tmp`, OUT);
  const up = out.find((state) => state.code === 9);
  const missingHi = up ? up.districts.filter((district) => !district.hi).map((district) => district.name) : [];
  console.log(`LGD: ${out.length} states/UTs, ${total} districts → ${path.relative(process.cwd(), OUT)}`);
  if (missingHi.length) console.warn(`UP districts without a Hindi name (add to district-names-up.json): ${missingHi.join(", ")}`);
}

main().catch((error) => {
  console.error("LGD ingestion stopped (previous file kept):", error.message);
  process.exit(1);
});
