import { readFileSync } from "fs";
import { PLAPI, PLExtAPI } from "paperlib-api/api";
import { PaperEntity } from "paperlib-api/model";
import { urlUtils } from "paperlib-api/utils";
import { PDFDocument } from "pdf-lib";

const DIRECT_API_ENDPOINTS: [prefix: string, url: string][] = [
  ["sonar", "https://api.perplexity.ai/chat/completions"],
];

type RequestMode = "gemini" | "openai" | "openrouter" | "perplexity";

function getRequestMode(model: string, customAPIURL: string): RequestMode {
  if (customAPIURL) return "openrouter";
  if (model.startsWith("gemini-")) return "gemini";
  if (model.startsWith("gpt-") || /^o\d/.test(model)) return "openai";
  if (model.startsWith("sonar")) return "perplexity";
  return "openrouter";
}

async function limitPDFPages(buf: Buffer, maxPages: number): Promise<Buffer> {
  const doc = await PDFDocument.load(new Uint8Array(buf));
  if (doc.getPageCount() <= maxPages) return buf;
  const newDoc = await PDFDocument.create();
  const pages = await newDoc.copyPages(doc, Array.from({ length: maxPages }, (_, i) => i));
  pages.forEach((p) => newDoc.addPage(p));
  return Buffer.from(await newDoc.save());
}

function buildGeminiURL(model: string, apiKey: string, customAPIURL: string): string {
  const base = customAPIURL || "https://generativelanguage.googleapis.com/";
  return new URL(`v1beta/models/${model}:generateContent?key=${apiKey}`, base).href;
}

function buildChatCompletionsURL(model: string, customAPIURL: string): string {
  if (customAPIURL) return new URL("v1/chat/completions", customAPIURL).href;
  const match = DIRECT_API_ENDPOINTS.find(([prefix]) => model.startsWith(prefix));
  return match?.[1] || "https://api.openai.com/v1/chat/completions";
}

async function post(url: string, headers: Record<string, string>, body: any): Promise<any> {
  const response = (await PLExtAPI.networkTool.post(url, body, headers, 0, 300000, false, true)) as any;
  if (response.body instanceof String || typeof response.body === "string") {
    return JSON.parse(response.body);
  }
  return response.body;
}

function extractText(response: any, mode: RequestMode): string {
  if (mode === "openai") {
    return response?.output_text ?? response?.output?.[0]?.content?.[0]?.text ?? "";
  }
  if (mode === "gemini") {
    return response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }
  return response?.choices?.[0]?.message?.content ?? "";
}

export function parseJSON(str: string): any {
  const match = str.match(/(\{(?:[^{}]|(?:\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}))*\})/);
  if (match && match.length > 0) return JSON.parse(match[0]);
  return JSON.parse(str);
}

export class AISummaryExtService {
  async summarize(
    paperEntity: PaperEntity,
    pageNum: number,
    prompt: string,
    systemInstruction: string,
    model: string,
    apiKey: string,
    customAPIURL: string,
  ) {
    const fileURL = await PLAPI.fileService.access(paperEntity.mainURL, true);
    const buf = await limitPDFPages(readFileSync(urlUtils.eraseProtocol(fileURL)), pageNum);
    const pdfBase64 = buf.toString("base64");
    const mode = getRequestMode(model, customAPIURL);

    let url = "";
    let headers: Record<string, string> = {};
    let body: any;

    if (mode === "openai") {
      url = "https://api.openai.com/v1/responses";
      headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
      body = {
        model,
        ...(systemInstruction && { instructions: systemInstruction }),
        input: [{ role: "user", content: [
          { type: "input_file", filename: "paper.pdf", file_data: `data:application/pdf;base64,${pdfBase64}` },
          { type: "input_text", text: prompt },
        ]}],
      };
    } else if (mode === "gemini") {
      url = buildGeminiURL(model, apiKey, customAPIURL);
      headers = { "Content-Type": "application/json" };
      body = {
        ...(systemInstruction && { systemInstruction: { parts: [{ text: systemInstruction }] } }),
        contents: [{ parts: [
          { text: prompt },
          { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
        ]}],
      };
    } else if (mode === "perplexity") {
      url = buildChatCompletionsURL(model, customAPIURL);
      headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
      body = {
        model,
        messages: [
          ...(systemInstruction ? [{ role: "system", content: systemInstruction }] : []),
          { role: "user", content: [
            { type: "text", text: prompt },
            { type: "file_url", file_url: { url: pdfBase64 } },
          ]},
        ],
      };
    } else if (mode === "openrouter") {
      url = buildChatCompletionsURL(model, customAPIURL);
      headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
      body = {
        model,
        messages: [
          ...(systemInstruction ? [{ role: "system", content: systemInstruction }] : []),
          { role: "user", content: [
            { type: "text", text: prompt },
            { type: "file", file: { filename: "paper.pdf", file_data: `data:application/pdf;base64,${pdfBase64}` } },
          ]},
        ],
        plugins: [{ id: "file-parser" }],
      };
    }

    const response = await post(url, headers, body);
    return extractText(response, mode);
  }

  async tag(
    paperEntity: PaperEntity,
    prompt: string,
    systemInstruction: string,
    model: string,
    apiKey: string,
    customAPIURL: string,
  ) {
    const fileURL = await PLAPI.fileService.access(paperEntity.mainURL, true);
    const buf = await limitPDFPages(readFileSync(urlUtils.eraseProtocol(fileURL)), 1);
    const pdfBase64 = buf.toString("base64");
    const mode = getRequestMode(model, customAPIURL);

    let url = "";
    let headers: Record<string, string> = {};
    let body: any;

    if (mode === "gemini") {
      url = buildGeminiURL(model, apiKey, customAPIURL);
      headers = { "Content-Type": "application/json" };
      body = {
        ...(systemInstruction && { systemInstruction: { parts: [{ text: systemInstruction }] } }),
        generationConfig: { responseMimeType: "application/json" },
        contents: [{ parts: [
          { text: prompt },
          { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
        ]}],
      };
    } else if (mode === "openai") {
      url = "https://api.openai.com/v1/responses";
      headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
      body = {
        model,
        ...(systemInstruction && { instructions: systemInstruction }),
        input: [{ role: "user", content: [
          { type: "input_file", filename: "paper.pdf", file_data: `data:application/pdf;base64,${pdfBase64}` },
          { type: "input_text", text: prompt },
        ]}],
      };
    } else if (mode === "openrouter") {
      url = buildChatCompletionsURL(model, customAPIURL);
      headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
      body = {
        model,
        messages: [
          ...(systemInstruction ? [{ role: "system", content: systemInstruction }] : []),
          { role: "user", content: [
            { type: "text", text: prompt },
            { type: "file", file: { filename: "paper.pdf", file_data: `data:application/pdf;base64,${pdfBase64}` } },
          ]},
        ],
        plugins: [{ id: "file-parser" }],
      };
    } else {
      url = buildChatCompletionsURL(model, customAPIURL);
      headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
      body = {
        model,
        messages: [
          ...(systemInstruction ? [{ role: "system", content: systemInstruction }] : []),
          { role: "user", content: prompt },
        ],
      };
    }

    const response = await post(url, headers, body);
    return extractText(response, mode);
  }

  async filter(
    paperEntities: PaperEntity[],
    prompt: string,
    systemInstruction: string,
    model: string,
    apiKey: string,
    customAPIURL: string,
  ) {
    const ids: number[] = [];
    const isGemini = model.startsWith("gemini-");
    const chunkSize = isGemini ? 400 : 200;

    const url = isGemini
      ? buildGeminiURL(model, apiKey, customAPIURL)
      : buildChatCompletionsURL(model, customAPIURL);
    const headers: Record<string, string> = isGemini
      ? { "Content-Type": "application/json" }
      : { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };

    const progressId = Math.floor(Math.random() * 1000000);

    for (let i = 0; i < paperEntities.length; i += chunkSize) {
      PLAPI.logService.progress(
        `Filtering papers ${i + 1} to ${Math.min(i + chunkSize, paperEntities.length)}`,
        (i / paperEntities.length) * 100,
        true,
        `AISummaryExt-${progressId}`,
      );

      const slice = paperEntities.slice(i, i + chunkSize);
      const dataStr = [
        "ID,Title,Authors,Publication,Year,Tags,Folders",
        ...slice.map((p, j) =>
          `ID:${i + j},Title:${p.title},Authors:${p.authors},Publication:${p.publication},Year:${p.pubTime},Tags:${p.tags.map((t) => t.name).join("/")},Folders:${p.folders.map((f) => f.name).join("/")}`,
        ),
      ].join("\n");

      const query = `I have a list of papers:\n${dataStr}\n${prompt}`;

      let body: any;
      if (isGemini) {
        body = {
          ...(systemInstruction && { systemInstruction: { parts: [{ text: systemInstruction }] } }),
          generationConfig: { responseMimeType: "application/json" },
          contents: [{ parts: [{ text: query }] }],
        };
      } else {
        body = {
          model,
          messages: [
            ...(systemInstruction ? [{ role: "system", content: systemInstruction }] : []),
            { role: "user", content: query },
          ],
        };
      }

      let filteredJSONIds = "";
      try {
        const response = await post(url, headers, body);
        filteredJSONIds = extractText(response, isGemini ? "gemini" : "openrouter");
      } catch (e) {
        PLAPI.logService.error("Failed to request LLM API.", e as Error, true, "AISummaryExt");
        continue;
      }

      try {
        ids.push(...(parseJSON(filteredJSONIds).ids as number[]));
      } catch (e) {
        PLAPI.logService.error(
          "Failed to parse the response of the filter model.",
          JSON.stringify(filteredJSONIds),
          false,
          "AISummaryExt",
        );
      }
    }

    PLAPI.logService.progress("Filtering papers done.", 100, true, `AISummaryExt-${progressId}`);
    return ids;
  }
}
