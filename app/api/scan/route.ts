declare const process: { env: Record<string, string | undefined> };

export const runtime = "nodejs";
export const maxDuration = 60;

type AnyRecord = Record<string, any>;
type CustomSerialRecord = {
  glove: string;
  custom: string;
  demand?: number;
  how?: string;
  cls?: string;
};

type ProviderResult = {
  parsed: AnyRecord | any[] | null;
  raw: string;
  provider: string;
  model: string;
  attempts: AnyRecord[];
};

function errorJson(message: string, status = 500, extra: AnyRecord = {}) {
  return Response.json({ error: message, ...extra }, { status });
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function parseModels(...values: Array<string | undefined>) {
  return unique(values.flatMap((value) => String(value || "").split(",")))
    .filter((model) => !/image|imagen|tts|audio|video/i.test(model));
}

function parseJson(raw: string): AnyRecord | any[] | null {
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  try {
    return JSON.parse(clean);
  } catch {}

  const objectStart = clean.indexOf("{");
  const objectEnd = clean.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      return JSON.parse(clean.slice(objectStart, objectEnd + 1));
    } catch {}
  }

  const arrayStart = clean.indexOf("[");
  const arrayEnd = clean.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(clean.slice(arrayStart, arrayEnd + 1));
    } catch {}
  }

  return null;
}

function normalize(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeFamily(value: unknown) {
  return normalize(
    String(value || "")
      .replace(/\[[^\]]+\]/g, " ")
      .replace(/#\s*-?\d+(?:\s*\/\s*\d+)?/g, " ")
      .replace(/\b(?:low|mid|high|serial|limited|class|custom)\b/gi, " ")
  );
}

function familyFrom(value: unknown) {
  const text = normalize(value);
  if (/\b(?:cyberfly|cyber fly|cf)\b/.test(text)) return "Cyberfly";
  if (/\bcore\b/.test(text)) return "Core";
  return "";
}

const COLOR_ALIASES: Record<string, string[]> = {
  BLK: ["blk", "black", "dark"],
  BLU: ["blu", "blue", "cyan"],
  RED: ["red"],
  PUR: ["pur", "purple", "violet"],
  PNK: ["pnk", "pink", "magenta"],
  GRN: ["grn", "green"],
  YLW: ["ylw", "yellow"],
  ORG: ["org", "orn", "orange"],
};

function colorFrom(value: unknown) {
  const text = normalize(value);
  const compact = text.replace(/\s+/g, "");

  for (const [code, aliases] of Object.entries(COLOR_ALIASES)) {
    if (
      aliases.some(
        (alias) =>
          new RegExp(`(^|\\s)${alias}($|\\s)`).test(text) || compact.includes(alias)
      )
    ) {
      return code;
    }
  }

  const raw = String(value || "").toUpperCase().replace(/0/g, "O");
  const tag = raw.match(/#\s*([A-Z](?:\s*[A-Z]){0,4})/);
  if (!tag) return "";
  const short = tag[1].replace(/\s+/g, "");
  if (short === "B") return "";
  if (short === "P") return "";
  if (["BLK", "BLU", "RED", "PUR", "PNK", "GRN", "YLW", "ORG", "ORN"].includes(short)) {
    return short === "ORN" ? "ORG" : short;
  }
  return "";
}

function parseRange(name: string) {
  let match = name.match(/\[\s*(\d+)\s*(?:-|–|—|to)\s*(\d+)\s*\]/i);
  if (match) return { min: Number(match[1]), max: Number(match[2]) };
  match = name.match(/\[\s*(\d+)\s*\+\s*\]/i);
  return match ? { min: Number(match[1]), max: Infinity } : null;
}

function numericSerial(value: AnyRecord | string) {
  const object = typeof value === "object" && value ? value : {};
  const direct = Number(
    object.serialNumber ?? object.serial ?? object.number ?? object.rank ?? 0
  );
  if (Number.isFinite(direct) && direct > 0) return direct;

  const text = String(
    object.visibleText ||
      object.text ||
      object.label ||
      object.visibleName ||
      value ||
      ""
  );

  const match =
    text.match(/#\s*(\d+)/i) ||
    text.match(/\bserial\s*#?\s*(\d+)/i) ||
    text.match(/\b(\d+)\s*\/\s*\d+\b/);

  return match ? Number(match[1]) : 0;
}

function serialTotal(value: AnyRecord | string) {
  const object = typeof value === "object" && value ? value : {};
  const direct = Number(object.serialTotal ?? object.total ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const text = String(
    object.visibleText || object.text || object.label || value || ""
  );
  const match = text.match(/(?:#\s*)?\d+\s*\/\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function customFingerprint(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ");
}

function customNormalized(value: unknown) {
  return customFingerprint(value)
    .replace(/^#+\s*/, "")
    .replace(/[^a-z0-9-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readText(value: unknown) {
  if (value && typeof value === "object") {
    const object = value as AnyRecord;
    return [
      object.visibleText,
      object.text,
      object.label,
      object.visibleName,
      object.baseName,
      object.name,
      object.glove,
      object.candidate,
      object.visibleTag,
      object.customSerialText,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return String(value || "");
}

function coerceConfidence(value: unknown, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, number));
}

function imageDataPart(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  return match ? { inlineData: { mimeType: match[1], data: match[2] } } : null;
}

async function callTokenBay(args: {
  apiKey: string;
  baseUrl: string;
  models: string[];
  images: string[];
  prompt: string;
}): Promise<ProviderResult> {
  const endpoint = args.baseUrl.endsWith("/v1")
    ? `${args.baseUrl}/chat/completions`
    : `${args.baseUrl}/v1/chat/completions`;
  const attempts: AnyRecord[] = [];

  for (const model of args.models) {
    try {
      const content: AnyRecord[] = [{ type: "text", text: args.prompt }];
      for (const image of args.images.slice(0, 10)) {
        content.push({
          type: "image_url",
          image_url: { url: image, detail: "high" },
        });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 54000);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content }],
          temperature: 0,
          max_tokens: 6000,
        }),
      });
      clearTimeout(timer);

      const data: AnyRecord = await response.json().catch(() => ({}));
      attempts.push({
        provider: "TokenBay Gemini",
        model,
        status: response.status,
        message: data?.error?.message || data?.message || "",
      });
      if (!response.ok) continue;

      const messageContent = data?.choices?.[0]?.message?.content;
      const raw = Array.isArray(messageContent)
        ? messageContent
            .map((part: AnyRecord) => part?.text || part?.content || "")
            .join("")
        : String(messageContent || data?.output_text || "");
      const parsed = parseJson(raw);
      if (parsed) {
        return {
          parsed,
          raw,
          provider: "TokenBay Gemini",
          model,
          attempts,
        };
      }
    } catch (error: any) {
      attempts.push({
        provider: "TokenBay Gemini",
        model,
        status: "exception",
        message: error?.message || String(error),
      });
    }
  }

  return {
    parsed: null,
    raw: "",
    provider: "TokenBay Gemini",
    model: "",
    attempts,
  };
}

async function callGoogle(args: {
  apiKey: string;
  models: string[];
  images: string[];
  prompt: string;
}): Promise<ProviderResult> {
  const attempts: AnyRecord[] = [];

  for (const model of args.models) {
    try {
      const parts: AnyRecord[] = [{ text: args.prompt }];
      for (const image of args.images.slice(0, 10)) {
        const part = imageDataPart(image);
        if (part) parts.push(part);
      }

      const endpoint =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(
          args.apiKey
        )}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 54000);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 6000,
            responseMimeType: "application/json",
          },
        }),
      });
      clearTimeout(timer);

      const data: AnyRecord = await response.json().catch(() => ({}));
      attempts.push({
        provider: "Google Gemini",
        model,
        status: response.status,
        message: data?.error?.message || "",
      });
      if (!response.ok) continue;

      const raw = (data?.candidates?.[0]?.content?.parts || [])
        .map((part: AnyRecord) => part?.text || "")
        .join("");
      const parsed = parseJson(raw);
      if (parsed) {
        return {
          parsed,
          raw,
          provider: "Google Gemini",
          model,
          attempts,
        };
      }
    } catch (error: any) {
      attempts.push({
        provider: "Google Gemini",
        model,
        status: "exception",
        message: error?.message || String(error),
      });
    }
  }

  return {
    parsed: null,
    raw: "",
    provider: "Google Gemini",
    model: "",
    attempts,
  };
}

export async function POST(req: Request) {
  try {
    const body: AnyRecord = await req.json().catch(() => ({}));
    const images = (Array.isArray(body.images) ? body.images : [])
      .map((image: unknown) => String(image || ""))
      .filter((image: string) => /^data:image\/[a-z0-9.+-]+;base64,/i.test(image))
      .slice(0, 10);

    const allowedNames = unique(
      (Array.isArray(body.gloveNames) ? body.gloveNames : []).map((name: unknown) =>
        String(name || "")
      )
    ).slice(0, 5000);

    const customSerialRecords: CustomSerialRecord[] = (
      Array.isArray(body.customSerials) ? body.customSerials : []
    )
      .map((item: AnyRecord) => ({
        glove: String(item?.glove || "").trim(),
        custom: String(item?.custom ?? "").trim(),
        demand: Number(item?.demand || 0) || undefined,
        how: String(item?.how || ""),
        cls: String(item?.cls || ""),
      }))
      .filter((item: CustomSerialRecord) => item.glove)
      .slice(0, 500);

    if (!images.length) return errorJson("No valid images sent.", 400);
    if (!allowedNames.length) return errorJson("No glove database names sent.", 400);

    const prompt = `
You are a precise inventory-card scanner for Roblox Boxing League.
There are ${images.length} inventory screenshot image(s). Scan EVERY visible glove card in EVERY image, row by row, left to right.
Do not stop after the first glove. Do not merge duplicate cards. One visible card = one detection object.

READ FOR EACH CARD:
1. The glove family/name printed below the icon.
2. Any color hashtag printed on the icon, including cropped tags.
3. Any numeric serial such as #30, #30/400, SERIAL #30, or 30/400.
4. Any custom serial text or symbol such as #TIME, #AMMO, #SIGMA, #-999999, a lock, trophy, skull, or other non-numeric custom marker.

COLORED CORE AND CYBERFLY:
- Core and Cyberfly/CF can have BLK, BLU, RED, PUR, PNK, GRN, YLW, ORG/ORN.
- Use the visible #tag when readable.
- When the tag is cut off, use the actual glove/accent color ONLY for Core and Cyberfly:
  blue/cyan=BLU, green=GRN, purple=PUR, pink/magenta=PNK, yellow=YLW, orange=ORG, red=RED, black/dark=BLK.
- A partly visible #B can mean BLU or BLK; decide from the glove color. A partly visible #P can mean PUR or PNK; decide from the glove color.
- Never apply these color rules to unrelated gloves.

NUMERIC SERIALS:
- Read the exact number and total when shown.
- The server will map the number to the correct allowed bracket, so return the family and number accurately.
- Never guess an unreadable number.

CUSTOM SERIALS:
- A custom serial is non-standard text, a symbol, zero, or a special negative number tied to a glove.
- Match only to the supplied Custom serial database.
- Never convert a custom serial into a normal numeric bracket.

CONFIDENCE:
- 95-100: name and tag/serial clearly readable.
- 82-94: strong visual/text evidence.
- Below 82: place it in review and explain what is unclear.

Return JSON only using this exact structure:
{
  "detections": [
    {
      "imageIndex": 1,
      "cardIndex": 1,
      "visibleName": "Cyberfly",
      "visibleText": "Cyberfly #BLU",
      "colorCode": "BLU",
      "serialType": "none",
      "serialNumber": null,
      "serialTotal": null,
      "customSerialText": "",
      "candidate": "Cyberfly [BLU]",
      "confidence": 97,
      "reason": "blue tag and blue glove"
    }
  ],
  "notes": "short scan summary"
}

Every card must be its own detections[] entry, including duplicate glove cards.
Only use exact candidate names from Allowed glove names when a standard/color/numeric serial candidate is known.
For custom serials, candidate may be empty; provide visibleName and customSerialText instead.

Allowed glove names:
${JSON.stringify(allowedNames)}

Custom serial database:
${JSON.stringify(customSerialRecords)}
`.trim();

    const tokenBayKey =
      process.env.TOKENBAY_GEMINI_API_KEY || process.env.TOKENBAY_API_KEY;
    const tokenBayModels = parseModels(
      process.env.TOKENBAY_GEMINI_MODELS,
      process.env.TOKENBAY_GEMINI_MODEL,
      process.env.TOKENBAY_GEMINI_MODEL_BACKUP,
      process.env.TOKENBAY_GEMINI_MODEL_FAST
    );
    const baseUrl = String(
      process.env.TOKENBAY_BASE_URL || "https://api.tokenbay.com"
    ).replace(/\/+$/, "");

    const attempts: AnyRecord[] = [];
    let result: ProviderResult | null = null;

    if (tokenBayKey && tokenBayModels.length) {
      const tokenBay = await callTokenBay({
        apiKey: tokenBayKey,
        baseUrl,
        models: tokenBayModels,
        images,
        prompt,
      });
      attempts.push(...tokenBay.attempts);
      if (tokenBay.parsed) result = tokenBay;
    }

    if (!result) {
      const googleKey = process.env.GEMINI_API_KEY;
      const googleModels = parseModels(
        process.env.GEMINI_MODELS,
        process.env.GEMINI_MODEL,
        process.env.GEMINI_MODEL_BACKUP
      );
      if (googleKey && googleModels.length) {
        const google = await callGoogle({
          apiKey: googleKey,
          models: googleModels,
          images,
          prompt,
        });
        attempts.push(...google.attempts);
        if (google.parsed) result = google;
      }
    }

    if (!result || !result.parsed) {
      return errorJson("All configured vision models failed or returned invalid JSON.", 502, {
        attempts,
      });
    }

    const exactMap = new Map(allowedNames.map((name) => [normalize(name), name]));
    const exactName = (value: unknown) => exactMap.get(normalize(value)) || null;

    const allowedEntries = allowedNames.map((name) => ({
      name,
      family: normalizeFamily(name),
      range: parseRange(name),
    }));

    function coloredCandidate(value: AnyRecord) {
      const raw = readText(value);
      const family = familyFrom(
        value.family || value.baseName || value.visibleName || value.name || raw
      );
      const code = String(
        value.colorCode || value.color || value.tag || colorFrom(raw)
      )
        .toUpperCase()
        .replace(/^#/, "")
        .replace("ORN", "ORG");

      if (!family || !code) return null;
      const candidates =
        family === "Core"
          ? code === "ORG"
            ? ["Core [ORN]", "Core [ORG]"]
            : [`Core [${code}]`]
          : code === "ORG"
          ? ["Cyberfly [ORG]", "Cyberfly [ORN]"]
          : [`Cyberfly [${code}]`];

      for (const candidate of candidates) {
        const hit = exactName(candidate);
        if (hit) return { candidate: hit, family, colorCode: code };
      }
      return null;
    }

    function numericSerialCandidate(value: AnyRecord) {
      const serial = numericSerial(value);
      if (!serial) return null;
      const rawFamily = normalizeFamily(
        value.baseName || value.visibleName || value.name || readText(value)
      );
      if (!rawFamily) return null;

      const options = allowedEntries
        .filter(
          (entry) =>
            entry.range &&
            (entry.family === rawFamily ||
              entry.family.includes(rawFamily) ||
              rawFamily.includes(entry.family))
        )
        .sort((a, b) => {
          const aScore = (a.family === rawFamily ? 10000 : 0) + a.family.length;
          const bScore = (b.family === rawFamily ? 10000 : 0) + b.family.length;
          return bScore - aScore;
        });

      const hit = options.find(
        (entry) => serial >= entry.range!.min && serial <= entry.range!.max
      );
      return hit
        ? {
            candidate: hit.name,
            serialNumber: serial,
            serialTotal: serialTotal(value) || undefined,
          }
        : null;
    }

    function customSerialCandidate(value: AnyRecord) {
      const raw = readText(value);
      const familyText = String(
        value.baseName || value.visibleName || value.name || value.glove || raw
      );
      const family = normalizeFamily(familyText);
      const stated = String(
        value.customSerialText || value.custom || value.visibleTag || value.serialText || ""
      ).trim();
      const rawFingerprint = customFingerprint(raw);
      const statedFingerprint = customFingerprint(stated);
      const rawNormalized = customNormalized(raw);
      const statedNormalized = customNormalized(stated);

      const matches = customSerialRecords.filter((record) => {
        const recordFamily = normalizeFamily(record.glove);
        const familyMatches =
          family &&
          (family === recordFamily ||
            family.includes(recordFamily) ||
            recordFamily.includes(family));
        if (!familyMatches) return false;

        const custom = record.custom;
        if (!custom) return false;
        const fingerprint = customFingerprint(custom);
        const normalizedCustom = customNormalized(custom);

        if (statedFingerprint && statedFingerprint === fingerprint) return true;
        if (statedNormalized && normalizedCustom && statedNormalized === normalizedCustom) {
          return true;
        }
        if (fingerprint && rawFingerprint.includes(fingerprint)) return true;
        if (normalizedCustom && rawNormalized.includes(normalizedCustom)) return true;
        return false;
      });

      if (matches.length !== 1) return null;
      const record = matches[0];
      const label = `${record.glove} [CUSTOM: ${record.custom || "blank"}]`;

      const sameFamilyStandard = allowedEntries.filter((entry) => {
        const recordFamily = normalizeFamily(record.glove);
        return (
          entry.family === recordFamily ||
          entry.family.includes(recordFamily) ||
          recordFamily.includes(entry.family)
        );
      });
      const noRange = sameFamilyStandard.filter((entry) => !entry.range);
      const baseCandidate = noRange.length === 1 ? noRange[0].name : null;

      return { record, label, baseCandidate };
    }

    function candidateSuggestions(value: AnyRecord) {
      const raw = normalize(value.visibleName || value.baseName || readText(value));
      if (!raw) return [];

      const direct = allowedEntries
        .filter(
          (entry) =>
            entry.family === raw || entry.family.includes(raw) || raw.includes(entry.family)
        )
        .map((entry) => entry.name);
      if (direct.length) return unique(direct).slice(0, 12);

      const tokens = raw.split(" ").filter((token) => token.length >= 3);
      return allowedEntries
        .filter((entry) => tokens.some((token) => normalize(entry.name).includes(token)))
        .map((entry) => entry.name)
        .slice(0, 12);
    }

    const parsed = result.parsed;
    const root: AnyRecord = Array.isArray(parsed) ? { detections: parsed } : parsed;
    let rawDetections: AnyRecord[] = Array.isArray(root?.detections)
      ? root.detections
      : [];

    if (!rawDetections.length) {
      const legacy: AnyRecord[] = [];
      for (const item of Array.isArray(root?.confirmed) ? root.confirmed : []) {
        legacy.push(typeof item === "string" ? { candidate: item, visibleText: item } : item);
      }
      for (const item of Array.isArray(root?.colored) ? root.colored : []) legacy.push(item);
      for (const item of Array.isArray(root?.serials) ? root.serials : []) legacy.push(item);
      for (const item of Array.isArray(root?.customSerials) ? root.customSerials : []) {
        legacy.push({ ...item, serialType: "custom" });
      }
      rawDetections = legacy;
    }

    const items: AnyRecord[] = [];
    const confirmed = new Set<string>();
    const colored: AnyRecord[] = [];
    const serials: AnyRecord[] = [];
    const customSerials: AnyRecord[] = [];
    const review: AnyRecord[] = [];
    const counts: Record<string, number> = {};

    rawDetections.slice(0, 300).forEach((detection, index) => {
      const value: AnyRecord =
        detection && typeof detection === "object"
          ? detection
          : { visibleText: String(detection || "") };
      const visibleText = readText(value);
      const confidence = coerceConfidence(value.confidence, 70);
      const serialType = String(value.serialType || "").toLowerCase();
      const exact = exactName(value.candidate || value.name || value.glove || value.visibleName);
      const custom =
        serialType === "custom" || value.customSerialText || value.custom
          ? customSerialCandidate(value)
          : customSerialCandidate(value);
      const serial = custom ? null : numericSerialCandidate(value);
      const color = !custom && !serial ? coloredCandidate(value) : null;
      const candidate = serial?.candidate || color?.candidate || exact || null;
      const item: AnyRecord = {
        imageIndex: Number(value.imageIndex || 1) || 1,
        cardIndex: Number(value.cardIndex || index + 1) || index + 1,
        visibleName: String(value.visibleName || value.baseName || value.name || ""),
        visibleText,
        confidence,
        reason: String(value.reason || ""),
        colorCode: color?.colorCode || String(value.colorCode || ""),
        serialNumber: serial?.serialNumber || numericSerial(value) || undefined,
        serialTotal: serial?.serialTotal || serialTotal(value) || undefined,
        candidate,
        status: "review",
        kind: "unknown",
      };

      if (custom) {
        item.kind = "custom";
        item.customSerialText = custom.record.custom;
        item.customLabel = custom.label;
        item.customRecord = custom.record;
        item.baseCandidate = custom.baseCandidate;
        item.status = confidence >= 82 ? "confirmed" : "review";
        customSerials.push({
          imageIndex: item.imageIndex,
          cardIndex: item.cardIndex,
          visibleText,
          glove: custom.record.glove,
          custom: custom.record.custom,
          label: custom.label,
          baseCandidate: custom.baseCandidate,
          confidence,
          reason: item.reason || "custom serial database match",
          status: item.status,
        });
      } else if (serial) {
        item.kind = "serial";
        item.status = confidence >= 78 ? "confirmed" : "review";
        serials.push({
          imageIndex: item.imageIndex,
          cardIndex: item.cardIndex,
          baseName: item.visibleName,
          visibleText,
          serial: serial.serialNumber,
          total: serial.serialTotal,
          candidate: serial.candidate,
          confidence,
          reason: item.reason || "numeric serial range match",
          status: item.status,
        });
      } else if (color) {
        item.kind = "colored";
        item.status = confidence >= 82 ? "confirmed" : "review";
        colored.push({
          imageIndex: item.imageIndex,
          cardIndex: item.cardIndex,
          family: color.family,
          colorCode: color.colorCode,
          visibleText,
          candidate: color.candidate,
          confidence,
          reason: item.reason || "colored family match",
          status: item.status,
        });
      } else if (candidate) {
        item.kind = "standard";
        item.status = confidence >= 82 ? "confirmed" : "review";
      }

      if (item.status === "confirmed" && candidate) {
        confirmed.add(candidate);
        counts[candidate] = (counts[candidate] || 0) + 1;
      } else if (item.status === "review") {
        review.push({
          imageIndex: item.imageIndex,
          cardIndex: item.cardIndex,
          text: visibleText || item.visibleName || `Card ${index + 1}`,
          candidates: candidate ? [candidate] : candidateSuggestions(value),
          confidence,
          reason:
            item.reason ||
            (custom
              ? "custom serial is not clear enough"
              : serial
              ? "numeric serial is not clear enough"
              : color
              ? "color/tag is not clear enough"
              : "glove name is uncertain"),
          kind: item.kind,
          customLabel: item.customLabel,
        });
      }

      items.push(item);
    });

    for (const legacyReview of Array.isArray(root?.review) ? root.review : []) {
      const value =
        legacyReview && typeof legacyReview === "object"
          ? legacyReview
          : { text: String(legacyReview || "") };
      review.push({
        imageIndex: Number(value.imageIndex || 1) || 1,
        cardIndex: Number(value.cardIndex || 0) || undefined,
        text: String(value.text || value.visibleText || value.read || "uncertain"),
        candidates: unique(
          (Array.isArray(value.candidates) ? value.candidates : [])
            .map((candidate: unknown) => exactName(candidate) || "")
            .filter(Boolean)
        ).slice(0, 12),
        confidence: coerceConfidence(value.confidence, 50),
        reason: String(value.reason || "model requested review"),
        kind: String(value.kind || "unknown"),
      });
    }

    return Response.json({
      items,
      confirmed: Array.from(confirmed),
      counts,
      colored,
      serials,
      customSerials,
      review: review.slice(0, 300),
      detectionCount: items.length,
      imageCount: images.length,
      notes:
        root?.notes ||
        `Scanned ${images.length} image(s) and processed ${items.length} visible card detection(s).`,
      provider: result.provider,
      model: result.model,
      attempts,
    });
  } catch (error: any) {
    return errorJson(error?.message || "Scanner server error.");
  }
}
