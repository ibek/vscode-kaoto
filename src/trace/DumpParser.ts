import { ExchangeEvent } from './types';

/**
 * Streaming parser for Camel `jbang camel trace --action=dump` output.
 *
 * Usage:
 *  const parser = new DumpParser((ev) => { ... });
 *  lines.forEach((l) => parser.feed(l));
 */
export class DumpParser {
	private currentEvent: ExchangeEvent | undefined;
	private onEvent: (ev: ExchangeEvent) => void;
	private currentEmitted: boolean = false;
	private isInBody: boolean = false;
	private lastStructuralKey: 'Service' | undefined;
	private expectedBodyBytes: number | undefined;
	private accumulatedBodyBytes: number = 0;
	private completionEmitTimer: NodeJS.Timeout | undefined;
	private bodyIdleEmitTimer: NodeJS.Timeout | undefined;

	private preprocess(line: string): string {
		const noAnsi = this.stripAnsi(line);
		// Remove optional container/log prefix like: "service-name    | "
		return noAnsi.replace(/^[^|]*\|\s+/, '');
	}

	// Header line example (colors can be present around the status):
	// 2025-08-14 00:45:23.093  16397 --- [ thread #7 - file://input]        ingestAndProcessTransactions/*--> :     1 - \x1b[32mCreated\x1b[m
	private static readonly headerRegex = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+\d+\s+---\s+\[[^\]]*]\s+([^:]+)\s*:\s*(\d+)\s*-\s*(.*)$/;

	constructor(onEvent: (ev: ExchangeEvent) => void) {
		this.onEvent = onEvent;
	}

	/**
	 * Feed a single line (without trailing newline). Parser keeps state between calls.
	 */
	public feed(line: string): void {
		// Detect header lines first (strip ANSI and optional log prefix to simplify parsing)
		const cleanForHeader = this.preprocess(line);
		const headerMatch = DumpParser.headerRegex.exec(cleanForHeader);
		if (headerMatch) {
			// if there is a current event being built, flush it first
			if (this.currentEvent) {
				this.flushCurrentEvent();
			}

			const timestamp = headerMatch[1];
			const nodeWithDirection = headerMatch[2].trim();
			const index = headerMatch[3];
			let rawStatus = headerMatch[4].trim();

			// Strip optional trailing duration e.g. "(3ms)"
			rawStatus = rawStatus.replace(/\s*\([^)]*\)\s*$/g, '');
			// Strip ANSI colors from status
			const status = this.stripAnsi(rawStatus);

			// exchangeId will be picked from subsequent "Exchange" line; init empty for now
			this.currentEvent = {
				timestamp,
				step: `${nodeWithDirection} : ${index} - ${status}`,
				status,
				headers: {},
				body: '',
				exchangeId: '',
			};
			this.currentEmitted = false;
			this.isInBody = false;
			this.expectedBodyBytes = undefined;
			this.accumulatedBodyBytes = 0;
			if (this.completionEmitTimer) {
				clearTimeout(this.completionEmitTimer);
				this.completionEmitTimer = undefined;
			}
			if (this.bodyIdleEmitTimer) {
				clearTimeout(this.bodyIdleEmitTimer);
				this.bodyIdleEmitTimer = undefined;
			}
			return;
		}

		// When inside an event, parse content lines
		if (this.currentEvent) {
			// Capture exchange id early if present on this line
			//   Exchange    ...  <exchange-id>
			const exId = this.tryExtractExchangeId(line);
			if (exId) {
				this.currentEvent.exchangeId = exId;
				// If this event likely has no body, emit immediately so it appears in UI promptly
				if (
					!this.currentEmitted &&
					!this.isInBody &&
					this.expectedBodyBytes === undefined &&
					/^(Completed|Processed)\b/i.test(this.currentEvent.status)
				) {
					// schedule a very short delayed emit to still allow any immediate structural lines to be captured
					this.completionEmitTimer = setTimeout(() => {
						if (this.currentEvent && !this.currentEmitted && this.currentEvent.exchangeId) {
							this.onEvent({ ...this.currentEvent });
							this.currentEmitted = true;
						}
						this.completionEmitTimer = undefined;
					}, 100);
				}
			}

			// Parse header key/value lines
			const header = this.tryExtractHeader(line);
			if (header) {
				const [key, value] = header;
				this.currentEvent.headers[key] = value;
				return;
			}

			// Parse structural lines (Endpoint, Service, Message, Exchange meta)
			if (this.tryExtractStructural(line)) {
				return;
			}

			// Detect beginning of body section and capture body meta if present
			const bodyMeta = this.tryParseBodyMarker(line);
			if (bodyMeta) {
				if (bodyMeta.type) this.currentEvent.headers['BodyType'] = bodyMeta.type;
				if (bodyMeta.bytes !== undefined) this.currentEvent.headers['BodyBytes'] = String(bodyMeta.bytes);
				this.expectedBodyBytes = bodyMeta.bytes;
				this.accumulatedBodyBytes = 0;
				this.isInBody = true;
				if (this.completionEmitTimer) {
					clearTimeout(this.completionEmitTimer);
					this.completionEmitTimer = undefined;
				}
				if (this.bodyIdleEmitTimer) {
					clearTimeout(this.bodyIdleEmitTimer);
					this.bodyIdleEmitTimer = undefined;
				}
				return; // do not include the marker line itself
			}

			// Ignore other structural lines (Endpoint, Service, Message, Exchange, etc.) unless inside body
			if (!this.isInBody) {
				return;
			}

			// Append line to body
			if (this.currentEvent.body.length > 0) {
				this.currentEvent.body += '\n' + line;
				this.accumulatedBodyBytes += Buffer.byteLength('\n', 'utf8') + Buffer.byteLength(line, 'utf8');
			} else {
				this.currentEvent.body = line;
				this.accumulatedBodyBytes += Buffer.byteLength(line, 'utf8');
			}

			// Debounced emit for bodies where byte count may not match exactly
			if (this.bodyIdleEmitTimer) {
				clearTimeout(this.bodyIdleEmitTimer);
			}
			this.bodyIdleEmitTimer = setTimeout(() => {
				if (this.currentEvent && !this.currentEmitted && this.currentEvent.exchangeId) {
					this.onEvent({ ...this.currentEvent });
					this.currentEmitted = true;
				}
				this.bodyIdleEmitTimer = undefined;
			}, 120);

			// If we know expected body size and have reached it, emit immediately
			if (
				this.expectedBodyBytes !== undefined &&
				this.accumulatedBodyBytes >= this.expectedBodyBytes &&
				this.currentEvent.exchangeId &&
				!this.currentEmitted
			) {
				this.onEvent({ ...this.currentEvent });
				this.currentEmitted = true;
				if (this.completionEmitTimer) {
					clearTimeout(this.completionEmitTimer);
					this.completionEmitTimer = undefined;
				}
			}
		}
	}

	private flushCurrentEvent(): void {
		if (!this.currentEvent) return;
		const ev = this.currentEvent;
		this.currentEvent = undefined;
		// Emit once when we have an exchange id (after we've collected headers/body)
		if (ev.exchangeId && ev.exchangeId.trim().length > 0 && !this.currentEmitted) {
			this.onEvent(ev);
		}
		if (this.completionEmitTimer) {
			clearTimeout(this.completionEmitTimer);
			this.completionEmitTimer = undefined;
		}
		if (this.bodyIdleEmitTimer) {
			clearTimeout(this.bodyIdleEmitTimer);
			this.bodyIdleEmitTimer = undefined;
		}
	}

	/**
	 * Call at end-of-stream to emit the last pending event if any.
	 */
	public done(): void {
		this.flushCurrentEvent();
	}

	private stripAnsi(text: string): string {
		// eslint-disable-next-line no-control-regex
		return text.replace(/\u001b\[[0-9;]*m/g, '');
	}

	private tryExtractExchangeId(line: string): string | undefined {
		// Example line (may start with spaces):
		//   Exchange    \x1b[99;2m(DefaultExchange)\x1b[m  \x1b[95;2mInOnly\x1b[m  \x1b[32mACD21AD...\x1b[m
		if (!/^\s*Exchange\s+/.test(line)) {
			return undefined;
		}
		const noAnsi = this.preprocess(line);
		// pick the last whitespace-separated token
		const parts = noAnsi.trim().split(/\s+/);
		// Prefer the last token that looks like an exchange id (contains a dash and has sufficient length)
		for (let i = parts.length - 1; i >= 0; i--) {
			const token = parts[i];
			if (token && token.includes('-') && /^[A-Za-z0-9-]+$/.test(token) && token.length >= 16) {
				return token;
			}
		}
		return undefined;
	}

	private tryExtractHeader(line: string): [string, string] | undefined {
		// Lines look like (may start with spaces):
		//   Header      \x1b[99;2m(String)\x1b[m  CamelFileName  20250415.csv
		if (!/^\s*Header\s+/.test(line)) {
			return undefined;
		}
		const noAnsi = this.preprocess(line);
		// Remove leading `Header` and type info in parentheses
		// Then split by two or more spaces to pick key and value
		const afterHeader = noAnsi.replace(/^\s*Header\s+\([^)]*\)\s+/, '');
		const match = afterHeader.match(/^(\S.*?)\s{2,}(.*)$/);
		if (match) {
			const key = match[1].trim();
			const value = match[2].trim();
			return [key, value];
		}
		return undefined;
	}

	private tryExtractStructural(line: string): boolean {
		const noAnsi = this.preprocess(line);
		// Endpoint line
		let m = /^\s*Endpoint\s+(.*\S)\s*$/.exec(noAnsi);
		if (m && this.currentEvent) {
			this.currentEvent.headers['Endpoint'] = m[1].trim();
			this.lastStructuralKey = undefined;
			return true;
		}
		// Service line (may be followed by a protocol continuation line)
		m = /^\s*Service\s+(.*\S)\s*$/.exec(noAnsi);
		if (m && this.currentEvent) {
			this.currentEvent.headers['Service'] = m[1].trim();
			this.lastStructuralKey = 'Service';
			return true;
		}
		// Continuation like:            (protocol=http)
		m = /^\s*\(([^)]*)\)\s*$/.exec(noAnsi);
		if (m && this.currentEvent && this.lastStructuralKey === 'Service') {
			const prev = this.currentEvent.headers['Service'] ?? '';
			this.currentEvent.headers['Service'] = prev ? `${prev} (${m[1]})` : `(${m[1]})`;
			return true;
		}
		// Message line: Message     (HttpMessage)
		m = /^\s*Message\s+\(([^)]*)\)\s*$/.exec(noAnsi);
		if (m && this.currentEvent) {
			this.currentEvent.headers['MessageType'] = m[1].trim();
			this.lastStructuralKey = undefined;
			return true;
		}
		// Exchange meta: Exchange    (DefaultExchange)       InOut        <id>
		if (/^\s*Exchange\s+/.test(noAnsi) && this.currentEvent) {
			const lineAfter = noAnsi.replace(/^\s*Exchange\s+/, '');
			const typeMatch = /^\(([^)]*)\)\s*(.*)$/.exec(lineAfter);
			let rest = lineAfter;
			if (typeMatch) {
				this.currentEvent.headers['ExchangeType'] = typeMatch[1].trim();
				rest = typeMatch[2] ?? '';
			}
			const parts = rest
				.trim()
				.split(/\s+/)
				.filter((p) => p.length > 0);
			// detect id and pattern
			let idIndex = -1;
			for (let i = parts.length - 1; i >= 0; i--) {
				const token = parts[i];
				if (token && token.includes('-') && /^[A-Za-z0-9-]+$/.test(token) && token.length >= 16) {
					idIndex = i;
					break;
				}
			}
			if (idIndex > 0) {
				const pattern = parts[idIndex - 1];
				if (pattern) this.currentEvent.headers['ExchangePattern'] = pattern;
			}
			this.lastStructuralKey = undefined;
			return true;
		}
		return false;
	}

	private tryParseBodyMarker(line: string): { type?: string; bytes?: number } | undefined {
		const noAnsi = this.preprocess(line);
		if (!/^\s*Body\s+/.test(noAnsi)) return undefined;
		// Patterns: Body  (String) (bytes: 249)
		const typeMatch = /Body\s*\(([^)]*)\)/.exec(noAnsi);
		const bytesMatch = /\(bytes:\s*(\d+)\)/.exec(noAnsi);
		const sizeMatch = /\(size:\s*(\d+)\b/.exec(noAnsi);
		const result: { type?: string; bytes?: number; size?: number } = {} as any;
		if (typeMatch) result.type = typeMatch[1].trim();
		if (bytesMatch) result.bytes = Number(bytesMatch[1]);
		if (sizeMatch) (result as any).size = Number(sizeMatch[1]);
		return result;
	}
}
