// The Gemini fallback (free tier): asked only about articles the Bangla patterns cannot settle,
// constrained to a JSON schema, and anything inconsistent is dropped.
//
// The model name comes from GEMINI_MODEL (workflow variable), default DEFAULT_GEMINI_MODEL, an
// alias Google keeps pointing at its current Flash model. A run starts by checking that the
// model exists; a missing model or any Gemini HTTP error is recorded in `GeminiStatus` and ends
// up in the run's issue (never only in the log).

import { dayOfKey, keyOfDay } from '../../app/src/lib/hijri/calendar.ts';
import { isValidDateKey } from '../../app/src/lib/hijri/remoteSchema.ts';
import type { Decision } from './decision.ts';
import { failureOf } from './newspapers.ts';

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
const API = 'https://generativelanguage.googleapis.com/v1beta';

export type GeminiStatus = {
  model: string;
  // 'off': no API key; 'ok': the model exists; 'missing': it does not (the 10 Nov 2026 HTTP 404);
  // 'error': the check itself failed (key rejected, network…).
  state: 'off' | 'ok' | 'missing' | 'error';
  // Why, for 'missing' and 'error'.
  problem: string | null;
  // generateContent models the key can use, listed when the configured one is missing.
  available: string[];
  // Errors while asking about articles (HTTP status, bad JSON…), one per article.
  errors: string[];
};

export const geminiOff = (model: string): GeminiStatus => ({
  model,
  state: 'off',
  problem: null,
  available: [],
  errors: [],
});

// Problems worth an issue: the model is missing, the check failed, or asking failed.
export const geminiProblem = (status: GeminiStatus): string | null => {
  if (status.state === 'missing' || status.state === 'error') {
    return `Gemini model "${status.model}": ${status.problem ?? status.state}`;
  }
  if (status.errors.length > 0) {
    return `Gemini model "${status.model}" failed on ${status.errors.length} article(s): ${status.errors.join('; ')}`;
  }
  return null;
};

type ModelInfo = { name?: string; supportedGenerationMethods?: string[] };

// Does `model` exist for this key? The models list (all pages) first; a name not in the list
// (an alias) is looked up directly. Never throws.
export async function checkGeminiModel(
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GeminiStatus> {
  const status: GeminiStatus = { model, state: 'ok', problem: null, available: [], errors: [] };
  const headers = { 'x-goog-api-key': apiKey };
  const wanted = `models/${model.replace(/^models\//, '')}`;
  const names: string[] = [];
  try {
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const url = `${API}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        return {
          ...status,
          state: 'error',
          problem: `models list: HTTP ${response.status}${response.status === 400 || response.status === 403 ? ' (API key rejected?)' : ''}`,
        };
      }
      const body = (await response.json()) as { models?: ModelInfo[]; nextPageToken?: string };
      for (const m of body.models ?? []) {
        if (m.name && (m.supportedGenerationMethods ?? []).includes('generateContent')) {
          names.push(m.name);
        }
      }
      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
  } catch (error) {
    return { ...status, state: 'error', problem: `models list: ${failureOf(error)}` };
  }
  if (names.includes(wanted)) return status;
  // Aliases such as "gemini-flash-latest" may not be listed; ask for the model itself.
  try {
    const response = await fetchImpl(`${API}/${wanted}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) return status;
    const available = names
      .map((n) => n.replace(/^models\//, ''))
      .filter((n) => /flash|pro/.test(n))
      .sort()
      .reverse()
      .slice(0, 12);
    return {
      ...status,
      state: response.status === 404 ? 'missing' : 'error',
      problem: `HTTP ${response.status}: not in the models list${response.status === 404 ? ' (set the GEMINI_MODEL repository variable to one that exists)' : ''}`,
      available,
    };
  } catch (error) {
    return { ...status, state: 'error', problem: `model lookup: ${failureOf(error)}` };
  }
}

// Asks Gemini about one article. HTTP errors throw (the caller logs them per article) and are
// also recorded in `status.errors`, so the issue lists them.
export function geminiAsker(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  options: { model?: string; status?: GeminiStatus } = {},
) {
  const model = (options.model ?? DEFAULT_GEMINI_MODEL).replace(/^models\//, '');
  return async (text: string, eveningKey: string, url: string): Promise<Decision | null> => {
    const prompt = `This is a Bangladeshi news article (${url}). Did Bangladesh's National Moon Sighting Committee (Islamic Foundation) decide on the evening of ${eveningKey} whether the new Hijri month's crescent was seen? Answer only from the text. month is 1-12 (Muharram=1), startDate is the first day of that month (YYYY-MM-DD), meetingDate is the date of the committee meeting the article reports. If the article does not report such a decision, set conclusive=false.\n\n${text.slice(0, 12_000)}`;
    let response: Response;
    try {
      response = await fetchImpl(`${API}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                conclusive: { type: 'BOOLEAN' },
                seen: { type: 'BOOLEAN' },
                month: { type: 'INTEGER' },
                hijriYear: { type: 'INTEGER' },
                startDate: { type: 'STRING' },
                meetingDate: { type: 'STRING' },
                source: { type: 'STRING' },
              },
              required: [
                'conclusive',
                'seen',
                'month',
                'hijriYear',
                'startDate',
                'meetingDate',
                'source',
              ],
            },
          },
        }),
      });
    } catch (error) {
      options.status?.errors.push(`${url}: ${failureOf(error)}`);
      throw error;
    }
    if (!response.ok) {
      const problem = `Gemini ${model}: HTTP ${response.status}${response.status === 404 ? ' (model not found)' : ''}`;
      options.status?.errors.push(`${url}: ${problem}`);
      throw new Error(problem);
    }
    const body = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    let answer: {
      conclusive: boolean;
      seen: boolean;
      month: number;
      hijriYear: number;
      startDate: string;
      meetingDate: string;
    };
    try {
      answer = JSON.parse(raw) as typeof answer;
    } catch {
      options.status?.errors.push(`${url}: Gemini ${model}: answer is not JSON`);
      return null;
    }
    const expectedStart = keyOfDay(dayOfKey(eveningKey) + (answer.seen ? 1 : 2));
    const consistent =
      answer.conclusive &&
      Number.isInteger(answer.month) &&
      answer.month >= 1 &&
      answer.month <= 12 &&
      isValidDateKey(answer.startDate) &&
      answer.startDate === expectedStart;
    if (!consistent) return null;
    return {
      seen: answer.seen,
      month: answer.month,
      hijriYear: Number.isInteger(answer.hijriYear) ? answer.hijriYear : null,
      startDate: answer.startDate,
      source: url,
      sameEvening: answer.meetingDate === eveningKey,
    };
  };
}
