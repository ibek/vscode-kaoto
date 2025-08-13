/* eslint-disable @typescript-eslint/no-explicit-any */
declare const acquireVsCodeApi: any;

type TraceOpenArgs = {
	integrationId: string;
	name: string;
	status: string;
};

type AppState = {
	ctx?: TraceOpenArgs;
	exchanges: Array<{ id: string; ts: number }>;
	selectedExchangeId?: string;
};

const vscode = acquireVsCodeApi();

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, any>, ...children: any[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (props) {
		for (const [k, v] of Object.entries(props)) {
			if (k === 'className') el.className = v as string;
			else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.substring(2).toLowerCase(), v as EventListener);
			else if (v !== undefined && v !== null) (el as any)[k] = v;
		}
	}
	for (const c of children) {
		if (c === undefined || c === null) continue;
		if (Array.isArray(c)) el.append(...c);
		else if (typeof c === 'string') el.append(document.createTextNode(c));
		else el.append(c);
	}
	return el;
}

function render(state: AppState) {
	const root = document.getElementById('root')!;
	root.innerHTML = '';

	const header = h(
		'div',
		{ className: 'header' },
		h('strong', {}, 'Integration:'),
		h('span', { id: 'name' }, state.ctx?.name ?? ''),
		h('span', { className: 'badge', id: 'status' }, state.ctx?.status ?? ''),
		h('span', { style: 'opacity:.7' }, `(${state.ctx?.integrationId ?? ''})`),
		h(
			'div',
			{ className: 'toolbar' },
			h(
				'button',
				{ className: 'primary', onClick: () => vscode.postMessage({ type: 'trace/start', payload: { integrationId: state.ctx?.integrationId } }) },
				'Start',
			),
			h('button', { onClick: () => vscode.postMessage({ type: 'trace/stop', payload: { integrationId: state.ctx?.integrationId } }) }, 'Stop'),
			h('button', { onClick: () => vscode.postMessage({ type: 'trace/clear', payload: { integrationId: state.ctx?.integrationId } }) }, 'Clear'),
		),
	);

	const left = h(
		'div',
		{ className: 'panel' },
		h('h3', {}, 'Traces by ExchangeId'),
		h(
			'div',
			{ className: 'body' },
			h(
				'ul',
				{ className: 'list' },
				state.exchanges.map((ex) =>
					h(
						'li',
						{
							className: state.selectedExchangeId === ex.id ? 'active' : '',
							onClick: () => {
								state.selectedExchangeId = ex.id;
								render(state);
							},
						},
						`${ex.id} • ${new Date(ex.ts).toLocaleTimeString()}`,
					),
				),
			),
		),
	);

	const right = h(
		'div',
		{ className: 'panel' },
		h('h3', {}, 'Exchange Details'),
		h(
			'div',
			{ className: 'body', id: 'details' },
			state.selectedExchangeId ? `Details for ${state.selectedExchangeId}` : 'Select an exchange to see details',
		),
	);

	const content = h('div', { className: 'content' }, left, right);
	const app = h('div', { className: 'app' }, header, content);
	root.append(app);
}

const state: AppState = { exchanges: [] };
render(state);

window.addEventListener('message', (event: MessageEvent) => {
	const msg = event.data;
	if (!msg) return;
	switch (msg.type) {
		case 'trace/status': {
			state.ctx = msg.payload as TraceOpenArgs;
			render(state);
			break;
		}
		case 'trace/clear': {
			state.exchanges = [];
			state.selectedExchangeId = undefined;
			render(state);
			break;
		}
		case 'trace/appendEvent': {
			const ev = msg.payload as { exchangeId: string; ts: number };
			state.exchanges.push({ id: ev.exchangeId, ts: ev.ts });
			render(state);
			break;
		}
		default:
			break;
	}
});
