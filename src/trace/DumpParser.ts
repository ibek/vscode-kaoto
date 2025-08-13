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
		// Detect header lines first (strip ANSI to simplify parsing)
		const cleanForHeader = this.stripAnsi(line);
		const headerMatch = DumpParser.headerRegex.exec(cleanForHeader);
		if (headerMatch) {
			// if there is a current event being built, flush it first
			if (this.currentEvent) {
				this.flushCurrentEvent();
			}

			const timestamp = headerMatch[1];
			const stepWithNode = headerMatch[2].trim();
			const step = stepWithNode; // keep as-is; UI may display full node path
			const index = headerMatch[3];
			let rawStatus = headerMatch[4].trim();

			// Strip optional trailing duration e.g. "(3ms)"
			rawStatus = rawStatus.replace(/\s*\([^)]*\)\s*$/g, '');
			// Strip ANSI colors from status
			const status = this.stripAnsi(rawStatus);

			// exchangeId will be picked from subsequent "Exchange" line; init empty for now
			this.currentEvent = {
				timestamp,
				step: `${index} - ${status}`,
				status,
				headers: {},
				body: '',
				exchangeId: '',
			};
			this.currentEmitted = false;
			return;
		}

		// When inside an event, parse body
		if (this.currentEvent) {
			// Try to capture exchange id from lines like:
			//   Exchange    ...  ACD21AD...
			const exId = this.tryExtractExchangeId(line);
			if (exId) {
				this.currentEvent.exchangeId = exId;
				// Emit early once we know the exchange id so the UI can render the node immediately
				if (!this.currentEmitted) {
					this.onEvent({ ...this.currentEvent });
					this.currentEmitted = true;
				}
				return;
			}

			// Parse header key/value lines
			const header = this.tryExtractHeader(line);
			if (header) {
				const [key, value] = header;
				this.currentEvent.headers[key] = value;
				return;
			}

			// Otherwise, append line to body (with newline)
			if (this.currentEvent.body.length > 0) {
				this.currentEvent.body += '\n' + line;
			} else {
				this.currentEvent.body = line;
			}
		}
	}

	private flushCurrentEvent(): void {
		if (!this.currentEvent) return;
		const ev = this.currentEvent;
		this.currentEvent = undefined;
		// Emit only if not emitted yet and we have an exchange id
		if (!this.currentEmitted && ev.exchangeId && ev.exchangeId.trim().length > 0) {
			this.onEvent(ev);
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
		const noAnsi = this.stripAnsi(line);
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
		const noAnsi = this.stripAnsi(line);
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
}
