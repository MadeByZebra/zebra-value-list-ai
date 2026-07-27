declare const process: { env: Record<string, string | undefined> };

export const runtime = "nodejs";
export const maxDuration = 300;

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

type ColorResolution = {
  family: "Core" | "Cyberfly";
  code?: string;
  candidate?: string;
  candidates: string[];
  safe: boolean;
  reason: string;
  source: "tag" | "partial-tag+visual" | "visual" | "unknown";
};

function errorJson(message: string, status = 500, extra: AnyRecord = {}) {
  return Response.json({ error: message, ...extra }, { status });
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function modelList(...values: Array<string | undefined>) {
  return unique(values.flatMap((value) => String(value || "").split(","))).filter(
    (model) => !/image|imagen|tts|audio|video/i.test(model)
  );
}

function parseJson(raw: string): AnyRecord | any[] | null {
  const clean = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

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

function familyFrom(value: unknown): "Core" | "Cyberfly" | "" {
  const text = normalize(value);
  if (/\b(?:cyberfly|cyber fly|cf)\b/.test(text)) return "Cyberfly";
  if (/\bcore\b/.test(text)) return "Core";
  return "";
}

const COLOR_CODES = ["BLK", "BLU", "RED", "PUR", "PNK", "GRN", "YLW", "ORG"];
const COLOR_ALIASES: Record<string, string[]> = {
  BLK: ["blk", "black", "blck", "blak", "bik", "b1k", "8lk", "tlk", "t1k"],
  BLU: ["blu", "blue", "cyan"],
  RED: ["red"],
  PUR: ["pur", "purple", "violet"],
  PNK: ["pnk", "pink", "magenta"],
  GRN: ["grn", "green"],
  YLW: ["ylw", "yellow"],
  ORG: ["org", "orn", "orange"],
};

function normalizeColorCode(value: unknown) {
  const raw = String(value || "")
    .toUpperCase()
    .replace(/^#/, "")
    .replace(/[^A-Z0-9]/g, "")
    .replace(/0/g, "O");

  if (raw === "ORN") return "ORG";

  if (
    ["BLK", "BLACK", "BLCK", "BLAK", "BIK", "B1K", "8LK", "TLK", "T1K", "BK"].includes(raw)
  ) {
    return "BLK";
  }

  return COLOR_CODES.includes(raw) ? raw : "";
}

function visibleText(value: AnyRecord | unknown) {
  if (value && typeof value === "object") {
    const object = value as AnyRecord;
    return [
      object.visibleText,
      object.tagText,
      object.visibleTag,
      object.text,
      object.label,
      object.visibleName,
      object.baseName,
      object.name,
      object.glove,
      object.customSerialText,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return String(value || "");
}

function explicitColorTag(value: AnyRecord) {
  const text = [
    value.tagText,
    value.visibleTag,
    value.visibleText,
    value.text,
    value.label,
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase()
    .replace(/0/g, "O");

  const spaced = text.match(/#\s*([A-Z])\s*([A-Z])\s*([A-Z])(?:\b|[^A-Z])/);
  if (spaced) {
    return normalizeColorCode(`${spaced[1]}${spaced[2]}${spaced[3]}`);
  }

  const compact = text.match(/#\s*(BLK|BLU|RED|PUR|PNK|GRN|YLW|ORG|ORN)\b/);
  return compact ? normalizeColorCode(compact[1]) : "";
}

function partialColorTag(value: AnyRecord) {
  const text = [value.tagText, value.visibleTag, value.visibleText, value.text]
    .filter(Boolean)
    .join(" ")
    .toUpperCase()
    .replace(/0/g, "O");

  if (explicitColorTag(value)) return "";
  const match = text.match(/#\s*([BPGYRO])(?:\b|[^A-Z])/);
  return match ? match[1] : "";
}

function inferredVisualColor(value: AnyRecord) {
  const direct = normalizeColorCode(
    value.visualColorCode || value.visualColor || value.colorCode || value.color
  );
  if (direct) return direct;

  const text = normalize(value.visualColorName || value.colorName || "");
  for (const code of COLOR_CODES) {
    if (COLOR_ALIASES[code].some((alias) => new RegExp(`(^|\\s)${alias}($|\\s)`).test(text))) {
      return code;
    }
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

  const text = visibleText(value);
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
  const match = visibleText(value).match(/(?:#\s*)?\d+\s*\/\s*(\d+)/i);
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

function confidence(value: unknown, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, number));
}

function detectedQuantity(value: AnyRecord) {
  const direct = Number(
    value.quantity ??
      value.qty ??
      value.count ??
      value.stackCount ??
      value.visibleQuantity ??
      1
  );
  if (!Number.isFinite(direct)) return 1;
  return Math.max(1, Math.min(99, Math.floor(direct)));
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

  for (const model of args.models.slice(0, 1)) {
    try {
      const content: AnyRecord[] = [{ type: "text", text: args.prompt }];
      for (const image of args.images.slice(0, 8)) {
        content.push({
          type: "image_url",
          image_url: { url: image },
        });
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content }],
          temperature: 0,
          max_tokens: 10000,
        }),
      });
      const rawBody = await response.text();
      let data: AnyRecord = {};
      try {
        data = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        data = { raw: rawBody };
      }

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
      if (parsed) return { parsed, raw, provider: "TokenBay Gemini", model, attempts };
    } catch (error: any) {
      attempts.push({
        provider: "TokenBay Gemini",
        model,
        status: "exception",
        message: error?.message || String(error),
      });
    }
  }

  return { parsed: null, raw: "", provider: "TokenBay Gemini", model: "", attempts };
}

async function callGoogle(args: {
  apiKey: string;
  models: string[];
  images: string[];
  prompt: string;
}): Promise<ProviderResult> {
  const attempts: AnyRecord[] = [];

  for (const model of args.models.slice(0, 1)) {
    try {
      const parts: AnyRecord[] = [{ text: args.prompt }];
      for (const image of args.images.slice(0, 8)) {
        const part = imageDataPart(image);
        if (part) parts.push(part);
      }

      const endpoint =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(args.apiKey)}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 10000,
            responseMimeType: "application/json",
          },
        }),
      });
      const rawBody = await response.text();
      let data: AnyRecord = {};
      try {
        data = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        data = { raw: rawBody };
      }

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
      if (parsed) return { parsed, raw, provider: "Google Gemini", model, attempts };
    } catch (error: any) {
      attempts.push({
        provider: "Google Gemini",
        model,
        status: "exception",
        message: error?.message || String(error),
      });
    }
  }

  return { parsed: null, raw: "", provider: "Google Gemini", model: "", attempts };
}

export async function POST(req: Request) {
  try {
    const body: AnyRecord = await req.json().catch(() => ({}));
    const images = (Array.isArray(body.images) ? body.images : [])
      .map((image: unknown) => String(image || ""))
      .filter((image: string) => /^data:image\/[a-z0-9.+-]+;base64,/i.test(image))
      .slice(0, 8);

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

    const censusPrompt = `
Count every visible Roblox Boxing League glove inventory CARD SLOT in all ${images.length} screenshot(s).

This is a geometry/counting pass only:
- Inspect the entire inventory grid from top-left to bottom-right.
- Count every visible rectangular glove card slot, including duplicates and low-confidence/unreadable cards.
- Count a partially visible card when enough of its rectangle is visible to know a slot exists.
- Ignore navigation, search results, filters, buttons, headings, and non-inventory UI.
- Do not return a sample. Do not stop after the first row or after six cards.
- For each image, report rowCounts: the number of visible card slots in each visual row.

Return JSON only:
{
  "images": [
    {"imageIndex": 1, "rowCounts": [4,4,4], "totalVisibleCardSlots": 12}
  ],
  "totalVisibleCardSlots": 12
}
`.trim();

    function censusTargets(parsed: AnyRecord | any[] | null) {
      const root: AnyRecord = parsed && !Array.isArray(parsed) ? parsed : {};
      const rows = Array.isArray(root.images) ? root.images : [];
      const byImage = rows.map((entry: AnyRecord, index: number) => {
        const rowCounts = Array.isArray(entry?.rowCounts)
          ? entry.rowCounts.map((value: unknown) => Math.max(0, Math.floor(Number(value) || 0)))
          : [];
        const total = Math.max(
          0,
          Math.floor(Number(entry?.totalVisibleCardSlots ?? entry?.total ?? 0) || 0),
          rowCounts.reduce((sum: number, value: number) => sum + value, 0)
        );
        return { imageIndex: Number(entry?.imageIndex || index + 1) || index + 1, rowCounts, total };
      });
      const summed = byImage.reduce((sum: number, entry: AnyRecord) => sum + Number(entry.total || 0), 0);
      const total = Math.max(
        summed,
        Math.floor(Number(root.totalVisibleCardSlots ?? root.total ?? 0) || 0)
      );
      return { byImage, total };
    }

    function detectionCount(parsed: AnyRecord | any[] | null) {
      if (Array.isArray(parsed)) return parsed.length;
      return Array.isArray((parsed as AnyRecord)?.detections)
        ? (parsed as AnyRecord).detections.length
        : 0;
    }

    function declaredSlotCount(parsed: AnyRecord | any[] | null) {
      if (!parsed || Array.isArray(parsed)) return 0;
      return Math.max(
        0,
        Math.floor(
          Number(
            (parsed as AnyRecord).totalVisibleCardSlots ??
              (parsed as AnyRecord).cardCount ??
              (parsed as AnyRecord).detectionCount ??
              0
          ) || 0
        )
      );
    }

    function detailedPrompt(census: ReturnType<typeof censusTargets>, retryNote = "") {
      const targets = census.byImage.length
        ? census.byImage
            .map((entry: AnyRecord) =>
              `Image ${entry.imageIndex}: ${entry.total} card slots` +
              (entry.rowCounts.length ? `, rows [${entry.rowCounts.join(", ")}]` : "")
            )
            .join("\n")
        : "No reliable census target was available; independently count every card slot first.";

      return `
Analyze all ${images.length} Roblox Boxing League inventory screenshot(s). Detect EVERY visible glove card slot, including duplicates and unreadable cards.

CARD-SLOT CENSUS TARGET:
${targets}
Total target: ${census.total || "count it yourself"} visible card slots.
${retryNote}

NON-NEGOTIABLE COMPLETENESS RULES:
- Scan the entire inventory grid systematically, row by row, left to right.
- Return exactly one detection object per visible card slot whenever a census target is supplied.
- Never return only the clearest cards, only unique glove names, or a representative sample.
- Never stop after six cards or after the first row.
- Separate repeated copies into separate objects. Do not merge duplicate card slots.
- If a card exists but its name is unreadable, STILL return that slot with visibleName "UNKNOWN", visibleText as much as can be read, confidence 0-40, and reason "unreadable card slot".
- Use quantity greater than 1 only when one card visibly shows an xN stack badge. Separate cards always remain separate detections.
- Preserve imageIndex, rowIndex, and columnIndex so every slot can be audited.

READING RULES:
- visibleName and visibleText must reflect only what is actually visible.
- tagText must preserve complete or partial tags exactly, such as #BLK or #B.
- visualColorCode may be BLK, BLU, RED, PUR, PNK, GRN, YLW, ORG only when visually supported.
- Never complete a cropped hashtag and never invent serial digits.
- Treat every colored Core/Cyberfly card as its own glove slot. Example: Core #GRN, Core #BLU, and Core #RED are THREE separate detections and THREE separate glove variants.
- For Core and Cyberfly, report the family plus exact tag/color evidence. A clear full color tag may be auto-saved as the exact colored variant; uncertain colors remain in Needs Review.

Return compact JSON only:
{
  "totalVisibleCardSlots": 12,
  "detections": [
    {
      "imageIndex": 1,
      "cardIndex": 1,
      "rowIndex": 1,
      "columnIndex": 1,
      "visibleName": "Cyberfly",
      "visibleText": "Cyberfly #BLU",
      "quantity": 1,
      "tagText": "#BLU",
      "visualColorCode": "BLU",
      "colorConfidence": 98,
      "serialNumber": null,
      "serialTotal": null,
      "customSerialText": "",
      "confidence": 98,
      "reason": "tag readable"
    }
  ],
  "notes": "complete row-by-row scan"
}
`;
    }

    // Put proven vision-capable chat models first. The previous route only tried
    // the first two configured names, so it could fail before reaching a model
    // that actually accepts image input.
    const fastModels = modelList(
      "gemini-2.5-flash",
      process.env.TOKENBAY_GEMINI_MODEL_FAST,
      process.env.TOKENBAY_GEMINI_MODEL,
      process.env.TOKENBAY_GEMINI_MODEL_BACKUP,
      process.env.TOKENBAY_GEMINI_MODELS
    );
    const tokenBayKey =
      process.env.TOKENBAY_GEMINI_API_KEY || process.env.TOKENBAY_API_KEY;
    const baseUrl = String(
      process.env.TOKENBAY_BASE_URL || "https://api.tokenbay.com"
    ).replace(/\/+$/, "");

    const attempts: AnyRecord[] = [];
    let result: ProviderResult | null = null;
    let census: ReturnType<typeof censusTargets> = { byImage: [], total: 0 };

    const googleKey = process.env.GEMINI_API_KEY;
    const googleModels = modelList(
      "gemini-2.5-flash",
      process.env.GEMINI_MODEL,
      process.env.GEMINI_MODEL_BACKUP,
      process.env.GEMINI_MODELS
    );

    async function runGoogleFullScan() {
      if (!googleKey || !googleModels.length) return null;
      const counted = await callGoogle({
        apiKey: googleKey,
        models: googleModels,
        images,
        prompt: censusPrompt,
      });
      attempts.push(...counted.attempts);
      census = censusTargets(counted.parsed);

      let detailed = await callGoogle({
        apiKey: googleKey,
        models: googleModels,
        images,
        prompt: detailedPrompt(census),
      });
      attempts.push(...detailed.attempts);

      const firstCount = detectionCount(detailed.parsed);
      const expectedCount = Math.max(census.total, declaredSlotCount(detailed.parsed));
      if (detailed.parsed && (expectedCount > firstCount || (firstCount > 0 && firstCount <= 6))) {
        const retry = await callGoogle({
          apiKey: googleKey,
          models: googleModels,
          images,
          prompt: detailedPrompt(
            census,
            `RETRY REQUIRED: the previous answer returned only ${firstCount} detections${expectedCount ? ` for an expected ${expectedCount} slots` : " and may have stopped early"}. Re-scan all rows and return every visible slot.`
          ),
        });
        attempts.push(...retry.attempts);
        if (detectionCount(retry.parsed) > firstCount) detailed = retry;
      }
      return detailed.parsed ? detailed : null;
    }

    async function runTokenBayFullScan() {
      if (!tokenBayKey || !fastModels.length) return null;
      const counted = await callTokenBay({
        apiKey: tokenBayKey,
        baseUrl,
        models: fastModels,
        images,
        prompt: censusPrompt,
      });
      attempts.push(...counted.attempts);
      census = censusTargets(counted.parsed);

      let detailed = await callTokenBay({
        apiKey: tokenBayKey,
        baseUrl,
        models: fastModels,
        images,
        prompt: detailedPrompt(census),
      });
      attempts.push(...detailed.attempts);

      const firstCount = detectionCount(detailed.parsed);
      const expectedCount = Math.max(census.total, declaredSlotCount(detailed.parsed));
      if (detailed.parsed && (expectedCount > firstCount || (firstCount > 0 && firstCount <= 6))) {
        const retry = await callTokenBay({
          apiKey: tokenBayKey,
          baseUrl,
          models: fastModels,
          images,
          prompt: detailedPrompt(
            census,
            `RETRY REQUIRED: the previous answer returned only ${firstCount} detections${expectedCount ? ` for an expected ${expectedCount} slots` : " and may have stopped early"}. Re-scan all rows and return every visible slot.`
          ),
        });
        attempts.push(...retry.attempts);
        if (detectionCount(retry.parsed) > firstCount) detailed = retry;
      }
      return detailed.parsed ? detailed : null;
    }

    // Two-pass scan: first count the grid, then read every counted slot.
    result = await runGoogleFullScan();
    if (!result) result = await runTokenBayFullScan();

    if (!result || !result.parsed) {
      const summary = attempts
        .slice(0, 8)
        .map((attempt) => {
          const provider = String(attempt.provider || "vision provider");
          const model = String(attempt.model || "unknown model");
          const status = String(attempt.status || "failed");
          const message = String(attempt.message || "no error message").slice(0, 180);
          return `${provider} / ${model} (${status}): ${message}`;
        })
        .join(" | ");

      return errorJson(
        `Vision scan failed. ${summary || "No usable Gemini provider was configured."}`,
        502,
        { attempts }
      );
    }

    const exactMap = new Map(allowedNames.map((name) => [normalize(name), name]));
    const exactName = (value: unknown) => exactMap.get(normalize(value)) || null;
    const allowedEntries = allowedNames.map((name) => ({
      name,
      family: normalizeFamily(name),
      range: parseRange(name),
    }));

    function colorVariantNames(family: "Core" | "Cyberfly", code: string) {
      if (family === "Core") {
        return code === "ORG" ? ["Core [ORN]", "Core [ORG]"] : [`Core [${code}]`];
      }
      return code === "ORG"
        ? ["Cyberfly [ORG]", "Cyberfly [ORN]"]
        : [`Cyberfly [${code}]`];
    }

    function exactVariant(family: "Core" | "Cyberfly", code: string) {
      for (const name of colorVariantNames(family, code)) {
        const hit = exactName(name);
        if (hit) return hit;
      }
      return null;
    }

    function allFamilyCandidates(family: "Core" | "Cyberfly") {
      const plain = exactName(family);
      return unique(
        [
          plain || "",
          ...COLOR_CODES.map((code) => exactVariant(family, code) || ""),
        ].filter(Boolean)
      );
    }

    function itemCandidateForColorPreview(
      family: "Core" | "Cyberfly",
      code: string
    ) {
      return code ? exactVariant(family, code) : null;
    }

    function partialCandidates(family: "Core" | "Cyberfly", partial: string) {
      const codes =
        partial === "B"
          ? ["BLK", "BLU"]
          : partial === "P"
          ? ["PNK", "PUR"]
          : partial === "G"
          ? ["GRN"]
          : partial === "Y"
          ? ["YLW"]
          : partial === "R"
          ? ["RED"]
          : partial === "O"
          ? ["ORG"]
          : COLOR_CODES;
      return unique(codes.map((code) => exactVariant(family, code) || "").filter(Boolean));
    }

    function resolveColor(value: AnyRecord): ColorResolution | null {
      const family = familyFrom(
        value.family || value.baseName || value.visibleName || value.name || visibleText(value)
      );
      if (!family) return null;

      const fullTag = explicitColorTag(value);
      const partialTag = partialColorTag(value);
      const visual = inferredVisualColor(value);
      const overall = confidence(value.confidence, 0);
      const colorConf = confidence(value.colorConfidence, overall);

      if (fullTag) {
        const candidate = exactVariant(family, fullTag);
        const visualCandidate = visual ? exactVariant(family, visual) : null;
        const visualDisagrees = Boolean(
          visual && visual !== fullTag && colorConf >= 90
        );
        const safe = Boolean(candidate) && !visualDisagrees && overall >= 72;
        return {
          family,
          code: fullTag,
          candidate: safe && candidate ? candidate : undefined,
          candidates: unique(
            [candidate || "", visualCandidate || ""].filter(Boolean)
          ),
          safe,
          reason: !candidate
            ? `#${fullTag} is not in the glove database`
            : visualDisagrees
            ? `visible #${fullTag} tag conflicts with detected ${visual} glove color`
            : safe
            ? `full visible #${fullTag} tag confirmed`
            : `full #${fullTag} tag was read, but confidence was too low`,
          source: "tag",
        };
      }

      if (partialTag) {
        const candidates = partialCandidates(family, partialTag);
        const visualCandidate = visual ? exactVariant(family, visual) : null;
        const visualCompatible = Boolean(
          visualCandidate && candidates.includes(visualCandidate)
        );
        const safe = Boolean(
          visualCandidate && visualCompatible && overall >= 90 && colorConf >= 92
        );
        return {
          family,
          code: safe ? visual : undefined,
          candidate: safe && visualCandidate ? visualCandidate : undefined,
          candidates: unique(
            [visualCandidate || "", ...candidates].filter(Boolean)
          ),
          safe,
          reason: safe
            ? `cropped #${partialTag} tag and high-confidence ${visual} visual color agree`
            : visual
            ? `cropped #${partialTag} tag; visual color looks ${visual}, so confirm it in Needs Review`
            : `cropped #${partialTag} tag is ambiguous; choose the correct color`,
          source: "partial-tag+visual",
        };
      }

      if (visual) {
        const candidate = exactVariant(family, visual);
        const safe = Boolean(candidate && overall >= 90 && colorConf >= 92);
        return {
          family,
          code: visual,
          candidate: safe && candidate ? candidate : undefined,
          candidates: candidate ? [candidate] : partialCandidates(family, ""),
          safe,
          reason: safe
            ? `high-confidence visible glove color confirmed as ${visual}`
            : `tag was unreadable; visual color looks ${visual}, so confirm it in Needs Review`,
          source: "visual",
        };
      }

      return {
        family,
        candidates: partialCandidates(family, ""),
        safe: false,
        reason: "Core/Cyberfly detected but color tag and glove color were unclear",
        source: "unknown",
      };
    }

    function numericSerialCandidate(value: AnyRecord) {
      const serial = numericSerial(value);
      if (!serial) return null;
      const rawFamily = normalizeFamily(
        value.baseName || value.visibleName || value.name || visibleText(value)
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
      const raw = visibleText(value);
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
        if (!familyMatches || !record.custom) return false;

        const fingerprint = customFingerprint(record.custom);
        const normalizedCustom = customNormalized(record.custom);
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
      const sameFamily = allowedEntries.filter((entry) => {
        const recordFamily = normalizeFamily(record.glove);
        return (
          entry.family === recordFamily ||
          entry.family.includes(recordFamily) ||
          recordFamily.includes(entry.family)
        );
      });
      const plain = sameFamily.filter((entry) => !entry.range);
      return {
        record,
        label,
        baseCandidate: plain.length === 1 ? plain[0].name : null,
      };
    }

    function suggestions(value: AnyRecord) {
      const raw = normalize(value.visibleName || value.baseName || visibleText(value));
      if (!raw) return [];
      const direct = allowedEntries
        .filter(
          (entry) =>
            entry.family === raw ||
            entry.family.includes(raw) ||
            raw.includes(entry.family)
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
    census.total = Math.max(census.total, declaredSlotCount(root));
    const rawDetections: AnyRecord[] = Array.isArray(root?.detections)
      ? [...root.detections]
      : [];

    // Never silently report a six-card partial scan when the census found more slots.
    // Missing/unreadable slots stay visible in Needs Review instead of disappearing.
    const expectedByImage = census.byImage.length
      ? census.byImage
      : [{ imageIndex: 1, total: census.total || rawDetections.length, rowCounts: [] }];
    for (const expected of expectedByImage) {
      const imageIndex = Number(expected.imageIndex || 1) || 1;
      const have = rawDetections.filter(
        (item: AnyRecord) => Number(item?.imageIndex || 1) === imageIndex
      ).length;
      const missing = Math.max(0, Number(expected.total || 0) - have);
      for (let index = 0; index < missing; index += 1) {
        rawDetections.push({
          imageIndex,
          cardIndex: have + index + 1,
          visibleName: "UNKNOWN",
          visibleText: "Unread card slot counted by grid census",
          quantity: 1,
          confidence: 0,
          reason: "card slot was counted but its glove text was unreadable",
        });
      }
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
      const text = visibleText(value);
      const conf = confidence(value.confidence, 65);
      const serialType = String(value.serialType || "").toLowerCase();
      const custom =
        serialType === "custom" || value.customSerialText || value.custom
          ? customSerialCandidate(value)
          : null;
      const serial = custom ? null : numericSerialCandidate(value);
      const color = !custom && !serial ? resolveColor(value) : null;

      let candidate: string | null = null;
      let kind = "unknown";
      let status = "review";
      let reason = String(value.reason || "");
      let candidates: string[] = [];

      if (custom) {
        kind = "custom";
        status = conf >= 88 ? "confirmed" : "review";
        reason = reason || "custom serial database match";
      } else if (serial) {
        kind = "serial";
        candidate = serial.candidate;
        candidates = [serial.candidate];
        status = conf >= 84 ? "confirmed" : "review";
        reason = reason || "numeric serial mapped to database range";
      } else if (color) {
        kind = "colored";
        candidate = color.safe && color.candidate ? color.candidate : null;
        candidates = candidate ? [candidate] : allFamilyCandidates(color.family);
        status = candidate ? "confirmed" : "review";
        reason = candidate
          ? `${candidate} detected as a separate colored glove and auto-saved. ${color.reason}`
          : `${color.family} detected. Choose plain ${color.family} or the exact color variant yourself. ${color.reason}`;
      } else {
        const exact = exactName(value.candidate || value.name || value.glove || value.visibleName);
        const exactLooksColored = exact ? /\[(?:BLK|BLU|RED|PUR|PNK|GRN|YLW|ORG|ORN)\]/i.test(exact) : false;
        if (exact && !exactLooksColored) {
          kind = "standard";
          candidate = exact;
          candidates = [exact];
          status = conf >= 84 ? "confirmed" : "review";
          reason = reason || "exact glove database match";
        } else {
          candidates = suggestions(value);
          reason = reason || "glove name, color, or serial was uncertain";
        }
      }

      const quantity = detectedQuantity(value);
      const item: AnyRecord = {
        imageIndex: Number(value.imageIndex || 1) || 1,
        cardIndex: Number(value.cardIndex || index + 1) || index + 1,
        rowIndex: Number(value.rowIndex || 0) || undefined,
        columnIndex: Number(value.columnIndex || 0) || undefined,
        quantity,
        visibleName: String(value.visibleName || value.baseName || value.name || ""),
        visibleText: text,
        tagText: String(value.tagText || value.visibleTag || ""),
        visualColorCode: inferredVisualColor(value),
        confidence: conf,
        reason,
        candidate,
        status,
        kind,
        serialNumber: serial?.serialNumber || numericSerial(value) || undefined,
        serialTotal: serial?.serialTotal || serialTotal(value) || undefined,
      };

      if (custom) {
        item.customSerialText = custom.record.custom;
        item.customLabel = custom.label;
        item.customRecord = custom.record;
        item.baseCandidate = custom.baseCandidate;
        customSerials.push({
          imageIndex: item.imageIndex,
          cardIndex: item.cardIndex,
          visibleText: text,
          glove: custom.record.glove,
          custom: custom.record.custom,
          label: custom.label,
          baseCandidate: custom.baseCandidate,
          confidence: conf,
          reason,
          status,
        });
      } else if (serial) {
        serials.push({
          imageIndex: item.imageIndex,
          cardIndex: item.cardIndex,
          baseName: item.visibleName,
          visibleText: text,
          serial: serial.serialNumber,
          total: serial.serialTotal,
          candidate: serial.candidate,
          confidence: conf,
          reason,
          status,
        });
      } else if (color) {
        colored.push({
          imageIndex: item.imageIndex,
          cardIndex: item.cardIndex,
          family: color.family,
          tagText: item.tagText,
          visualColorCode: item.visualColorCode,
          colorCode: color.code || "",
          visibleText: text,
          candidate,
          candidates: candidate ? [candidate] : allFamilyCandidates(color.family),
          confidence: conf,
          reason,
          source: color.source,
          status,
          quantity,
        });
      }

      if (status === "confirmed" && candidate) {
        confirmed.add(candidate);
        counts[candidate] = (counts[candidate] || 0) + quantity;
      } else if (status === "review") {
        review.push({
          imageIndex: item.imageIndex,
          cardIndex: item.cardIndex,
          text: text || item.visibleName || `Card ${index + 1}`,
          candidates: color
            ? allFamilyCandidates(color.family)
            : unique(candidates).slice(0, 12),
          confidence: conf,
          reason,
          kind,
          customLabel: item.customLabel,
          quantity,
          family: color?.family || undefined,
          tagText: item.tagText || undefined,
        });
      }

      items.push(item);
    });

    return Response.json({
      items,
      confirmed: Array.from(confirmed),
      counts,
      colored,
      serials,
      customSerials,
      review: review.slice(0, 300),
      detectionCount: items.length,
      cardCount: items.length,
      expectedCardCount: census.total || items.length,
      censusByImage: census.byImage,
      gloveCount: items.reduce(
        (total, item) => total + detectedQuantity(item),
        0
      ),
      imageCount: images.length,
      notes:
        root?.notes ||
        `Full-grid scan processed ${items.length} card slot(s). Ambiguous or unreadable slots remain in Needs Review.`,
      provider: result.provider,
      model: result.model,
      attempts,
      scanMode: "version-1.9.0-full-grid-two-pass-colored-variants",
    });
  } catch (error: any) {
    return errorJson(error?.message || "Scanner server error.");
  }
}
