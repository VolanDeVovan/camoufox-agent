// Is a stored fpgen fingerprint a stable identity across launches?
import { launchOptions } from "camoufox";
import { utilsDeps, camouConfigBlob, getScreenCons } from "camoufox/dist/utils.js";
const fp0 = await utilsDeps.generateFingerprint({ screen: getScreenCons(false) ?? undefined, os: "linux" });
const stored = JSON.stringify(fp0);
console.log("fingerprint bytes:", stored.length, "keys:", Object.keys(fp0));
const cfg = async () => JSON.parse(camouConfigBlob(await launchOptions({ headless: false, os: "linux", fingerprint: JSON.parse(stored), i_know_what_im_doing: true, humanize: 0.5 })));
const a = await cfg(), b = await cfg();
const diff = Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
console.log("config keys:", Object.keys(a).length, "differing between two launches:", diff);
const pick = (c) => Object.fromEntries(Object.entries(c).filter(([k]) => /^(screen|window)\.|userAgent|hardwareConc|webGl:(vendor|renderer)|platform/.test(k)));
console.log(pick(a));
const c = JSON.parse(camouConfigBlob(await launchOptions({ headless: true, os: "linux", fingerprint: JSON.parse(stored), i_know_what_im_doing: true })));
console.log("headless vs headed differing:", Object.keys({ ...a, ...c }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(c[k])));
