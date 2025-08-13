/* eslint-disable @typescript-eslint/no-explicit-any */
declare const acquireVsCodeApi: any;

type TraceOpenArgs = {
	integrationId: string;
	name: string;
	status: string;
};

type ExchangeEvent = { timestamp: string; step: string; status: string; headers: Record<string, string>; body: string; exchangeId: string };
type AppState = {
	ctx?: TraceOpenArgs;
	// grouped by exchangeId
	byExchange: Record<string, ExchangeEvent[]>;
	// UI
	expanded: Record<string, boolean>;
	selectedExchangeId?: string;
	selectedIndex?: number;
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

function renderDetails(ev: ExchangeEvent) {
	return h(
		'div',
		{},
		h('div', {}, `${ev.timestamp} — ${ev.step}`),
		h('div', { style: 'margin-top:.25rem; font-weight:600' }, 'Headers'),
		h(
			'ul',
			{ className: 'list' },
			Object.entries(ev.headers).map(([k, v]) => h('li', {}, `${k}: ${v}`)),
		),
		h('div', { style: 'margin-top:.25rem; font-weight:600' }, 'Body'),
		h('pre', {}, ev.body || '(empty)'),
	);
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
				Object.keys(state.byExchange)
					.filter((exId) => !!exId && exId.trim().length > 0)
					.map((exId) =>
						h(
							'li',
							{},
							h(
								'div',
								{
									onClick: () => {
										state.expanded[exId] = !state.expanded[exId];
										state.selectedExchangeId = exId;
										state.selectedIndex = undefined;
										render(state);
									},
									className: state.selectedExchangeId === exId ? 'active' : '',
								},
								`${state.expanded[exId] ? '▾' : '▸'} ${exId}`,
							),
							state.expanded[exId]
								? h(
										'ul',
										{ className: 'list', style: 'margin-left: 0.75rem' },
										state.byExchange[exId].map((ev, idx) =>
											h(
												'li',
												{
													className: state.selectedExchangeId === exId && state.selectedIndex === idx ? 'active' : '',
													onClick: (e: MouseEvent) => {
														e.stopPropagation();
														state.selectedExchangeId = exId;
														state.selectedIndex = idx;
														render(state);
													},
												},
												`${ev.step}`,
											),
										),
									)
								: undefined,
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
			state.selectedExchangeId && state.selectedIndex !== undefined
				? renderDetails(state.byExchange[state.selectedExchangeId][state.selectedIndex])
				: 'Select an exchange to see details',
		),
	);

	const content = h('div', { className: 'content' }, left, right);
	const app = h('div', { className: 'app' }, header, content);
	root.append(app);
}

const state: AppState = { byExchange: {}, expanded: {} } as AppState;
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
			state.byExchange = {};
			state.expanded = {};
			state.selectedExchangeId = undefined;
			state.selectedIndex = undefined;
			render(state);
			break;
		}
		case 'trace/appendEvent': {
			const ev = msg.payload as ExchangeEvent;
			if (!state.byExchange[ev.exchangeId]) state.byExchange[ev.exchangeId] = [];
			state.byExchange[ev.exchangeId].push(ev);
			render(state);
			break;
		}
		default:
			break;
	}
});
