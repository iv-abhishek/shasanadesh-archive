import assert from "node:assert/strict";
import { admit, kindOf } from "./admission.js";
import { extractItems, formFields, looksLikeGoNumber, pagerOf, parseDayMonthYear } from "./extract.js";
import { siteHosts, visibilityFor, type CrawlSite } from "./register.js";
import { crawlSourceId } from "../sources/crawl-sites.js";
import { namesDistrict } from "./visibility.js";

const site: Pick<CrawlSite, "docTypes" | "level"> = { docTypes: ["go"], level: "state-hq" };

// UP CMS GridView row (uplc.up.gov.in): subject span, size/language noise, date, relative download link.
const upCms = `
<table id="gv"><tr><th>S.No.</th><th>Order No.</th><th>Subject</th><th>Date</th><th>Download</th></tr>
<tr><td class="gridrow">1</td><td class="gridrow"><span>823/78 - 2 - 2021 -254 L.C/2019TC</span></td>
<td class="gridrow"><span>Uttar Pradesh Data Center Policy 2021</span> <span class='dsize'> [2 MB]</span> <span class='licon'><b>Language : </b>English</span></td>
<td class="gridrow"><span>17/06/2022</span></td>
<td class="gridrow"><a class="btn&#32;btn-primary" href="../downloadmedia/UploadGovermentOrder/pdf/C_202508041437188519.pdf"> View/Download </a></td></tr>
<tr class="pagination"><td colspan="5"><table><tr><td><span>Displaying 1 - 10 of 63</span></td><td><span>1</span></td>
<td><a href="javascript:__doPostBack(&#39;ctl00$Body$gv&#39;,&#39;Page$2&#39;)">2</a></td></tr></table></td></tr></table>
<form><input type="hidden" name="__VIEWSTATE" value="abc"><input type="text" name="q" value=""><input type="submit" name="go" value="Search">
<select name="ddlYear"><option value="0">All</option><option value="2026" selected>2026</option></select></form>`;

const [policy] = extractItems(upCms, "https://uplc.up.gov.in/en/archivegovernmentorders");
assert.equal(policy.url, "https://uplc.up.gov.in/downloadmedia/UploadGovermentOrder/pdf/C_202508041437188519.pdf");
assert.equal(policy.title, "Uttar Pradesh Data Center Policy 2021");
assert.equal(policy.date, "2022-06-17");
assert.equal(policy.goNumber, "823/78 - 2 - 2021 -254 L.C/2019TC");
assert.equal(policy.language, "en");
assert.equal(admit(policy, site).kind, "policy");

const pager = pagerOf(upCms, "https://uplc.up.gov.in/en/archivegovernmentorders");
assert.deepEqual(pager.postBacks, [{ target: "ctl00$Body$gv", argument: "Page$2" }]);
assert.equal(pager.totalItems, 63);
assert.equal(pager.pageSize, 10);
assert.deepEqual(formFields(upCms), [["__VIEWSTATE", "abc"], ["q", ""], ["ddlYear", "2026"]]);

// NIC hand-made table: GO number is the link text, Hindi subject in the next cell, unquoted href elsewhere.
const nic = `<table><tr><td>न0वि0-4</td><td>18-08-2020</td>
<td><a href="https://urbandevelopment.up.nic.in/data/Govt_Orders/NV-4-1342[18-08-20]-GO.pdf"> 1342/नौ-4-2020-10ड0ब्लू/2016</a></td>
<td>उ0प्र0 पालिका (केन्द्रीयित) पशु चिकित्सा सेवा संवर्ग के पशुचिकित्सा अधिकारियों की सेवा शर्तें</td></tr>
<tr><td width="83%"><a href=book/Chapter-18.pdf target =_blank>CHAPTER XVIII- DEPOSITS</a></td><td>612-627</td></tr></table>`;
const [go, chapter] = extractItems(nic, "https://urbandevelopment.up.nic.in/GO_main_menu-2017.html");
assert.equal(go.goNumber, "1342/नौ-4-2020-10ड0ब्लू/2016");
assert.equal(go.date, "2020-08-18");
assert.match(go.title, /पशु चिकित्सा सेवा संवर्ग/);
assert.equal(chapter.url, "https://urbandevelopment.up.nic.in/book/Chapter-18.pdf");
assert.equal(chapter.title, "CHAPTER XVIII- DEPOSITS");

// Number and date in one cell; document links that do not end in .pdf.
const combined = `<table><tr><td>3</td><td>Finance (General) Section-3</td><td>11/2024/S-3-227/10-19099/4/2024 / 12 Jun 2024</td>
<td>Regarding notional increment on retirement</td><td><a href="../DocFileForms/ViewDoc.aspx?id=4583"></a></td></tr></table>`;
assert.equal(extractItems(combined, "https://panchayatiraj.up.nic.in/pblc_pg/Docs/ViewDocument?id=8").length, 0);
const [viewDoc] = extractItems(combined, "https://panchayatiraj.up.nic.in/pblc_pg/Docs/ViewDocument?id=8", { docLinkPattern: /ViewDoc\.aspx\?id=\d+/i });
assert.equal(viewDoc.goNumber, "11/2024/S-3-227/10-19099/4/2024");
assert.equal(viewDoc.date, "2024-06-12");
assert.equal(viewDoc.title, "Regarding notional increment on retirement");

// Menus: a link inside a block of many links takes its own label, not the menu's text.
const menu = `<div class="topnav"><a href="/a">निविदा प्रकाशन</a><a href="/b">योजना</a><a href="/public/pdf/Account-Manual2004.pdf">लेखा मैनुअल </a></div>`;
assert.equal(extractItems(menu, "https://www.awasbandhu.in/hi/pages/order-list")[0].title, "लेखा मैनुअल");

assert.equal(parseDayMonthYear("dated 09th June, 2020"), "2020-06-09");
assert.equal(parseDayMonthYear("4 March 2021"), "2021-03-04");
assert.ok(looksLikeGoNumber("G-4-484/X-90-216-79"));
assert.ok(looksLikeGoNumber("संख्या-1889/33-3-20"));
assert.ok(!looksLikeGoNumber("18-08-2020"));
assert.ok(!looksLikeGoNumber("Regarding the formation of empowered committee under the IT policy 2022"));

// Admission: notices go, rules about the same subjects stay; budget releases are records.
const item = (title: string) => ({ url: "https://x.up.gov.in/a.pdf", title, linkLabel: "View", date: null, goNumber: null, language: "hi" as const, cells: [] });
assert.equal(admit(item("ई-निविदा सूचना — भवन मरम्मत कार्य"), site).reason, "tender");
assert.equal(admit(item("Guidelines to Prevent Conflict of Interest in Tender-Related Processes"), site).admitted, true);
assert.equal(admit(item("सहायक अध्यापक भर्ती परीक्षा परिणाम"), site).reason, "recruitment/exam");
assert.equal(admit(item("उत्तर प्रदेश अधीनस्थ सेवा भर्ती नियमावली 2026"), site).admitted, true);
assert.equal(admit(item("श्री राम कुमार, सहायक अभियन्ता का स्थानान्तरण"), site).reason, "individual personnel order");
assert.equal(admit(item("Annual Transfer Policy of Government Officers/Employees Year-2024-25"), site).admitted, true);
assert.equal(kindOf("वित्तीय वर्ष 2026-27 में धनराशि अवमुक्त किये जाने के सम्बन्ध में", site), "budget-release");
assert.equal(admit(item("जिला स्तरीय बैठक की सूचना"), { docTypes: ["notice"], level: "district" }).reason, "district notice");

// Register: http only where written; district documents are not for headquarters by default.
const httpSite = { listingUrls: ["http://samajkalyan.up.gov.in/hi/governmentorders"], fileHosts: [] } as unknown as CrawlSite;
assert.deepEqual(siteHosts(httpSite).httpHosts.sort(), ["samajkalyan.up.gov.in", "www.samajkalyan.up.gov.in"]);
assert.deepEqual(siteHosts({ listingUrls: ["https://doe.gov.in/en/x"] } as unknown as CrawlSite).httpHosts, []);
assert.equal(visibilityFor("district"), "district");
assert.equal(visibilityFor("directorate"), "all");
assert.match(crawlSourceId("uplc-gos", "https://uplc.up.gov.in/a.pdf"), /^crawl-uplc-gos-[0-9a-f]{12}$/);

assert.ok(namesDistrict("GeM orders issued by Lucknow district"));
assert.ok(namesDistrict("प्रयागराज जनपद में अवमुक्त धनराशि"));
assert.ok(!namesDistrict("earned leave limit under FR 81-B"));

console.log("crawl tests passed");
