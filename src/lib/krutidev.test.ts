/**
 * Kruti Dev → Unicode. Inputs are lines from the Finance Department's Vitta
 * Path PDFs (budget.up.nic.in/vittapath) as pdftotext returns them.
 */

import assert from "node:assert/strict";
import { krutiDevToUnicode, looksLikeKrutiDev } from "./krutidev.js";

const cases: Array<[string, string]> = [
  ["foŸkh; vf/kdkj¨a dk izfrfu/kk;u", "वित्तीय अधिकारों का प्रतिनिधायन"],
  ["foÙkh; gLriqfLrdk [k.M&ik¡p Hkkx&1", "वित्तीय हस्तपुस्तिका खण्ड-पाँच भाग-1"],
  // short i before its cluster, reph after its syllable
  ["dk;kZy;k/;{k", "कार्यालयाध्यक्ष"],
  ["/kkfeZd", "धार्मिक"],
  ["dkÆed", "कार्मिक"],
  ["okÆ\"kd", "वार्षिक"],
  ["fLFkfr", "स्थिति"],
  // alternate glyph slots used by these PDFs
  ["g¨rs", "होते"],
  ["y®d", "लोक"],
  ["v©j", "और"],
  ["ÁcaËku", "प्रबंधन"],
  ["Òkjr", "भारत"],
  ["mŒÁŒ", "उ०प्र०"],
  ["vko’;drk", "आवश्यकता"],
  ["dysDVªsV", "कलेक्ट्रेट"],
  ["d¨Ã", "कोई"],
  ["y[kuÅ", "लखनऊ"],
  ["LohÑr", "स्वीकृत"],
  // fixes for typing order
  ["ifjizs{;", "परिप्रेक्ष्य"],
  ["ekWMy", "मॉडल"],
  ["`5,000", "₹5,000"],
  // English inside the Kruti Dev text stays English
  ["ekudksa ¼Standards of Financial Propriety½ dk", "मानकों (Standards of Financial Propriety) का"],
  ["vf/kdkfj;ksa ¼DDO½ dks", "अधिकारियों (DDO) को"],
  ["dj ¼Self assessment tax½ gsrq", "कर (Self assessment tax) हेतु"],
  ["erns; ¼Voted½A", "मतदेय (Voted)।"],
];
for (const [input, expected] of cases) assert.equal(krutiDevToUnicode(input), expected, input);

// Detection: Kruti Dev pages yes; English rules and Unicode Hindi no.
const kruti = "'kkldh; /ku dk fdlh izdkj ds O;; ds fy, iz;ksx djus ls iwoZ vFkok mldk fdlh Hkh iz;kstu ds fy, fdlh Hkh O;fDr dks Hkqxrku djus vFkok vfxze nsus ls iwoZ fuEufyf[kr ewyHkwr 'krsZa vo'; iwjh dh tkuh pkfg,A";
assert.equal(looksLikeKrutiDev(kruti), true);
const english = "127. An annual statement showing the numerical strength of each office as in Annexure A to this chapter shall be prepared by the Head of Department and sent to Government in the administrative department, which will pass on the same to the Finance Department.";
assert.equal(looksLikeKrutiDev(english), false);
assert.equal(looksLikeKrutiDev("नियमावली के अनुसार वेतन का भुगतान किया जाएगा। ".repeat(10)), false);
assert.equal(looksLikeKrutiDev("ds dh"), false);

console.log(`krutidev tests passed (${cases.length} conversions)`);
