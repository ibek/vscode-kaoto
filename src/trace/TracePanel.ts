/**
 * Copyright 2025 Red Hat, Inc. and/or its affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as vscode from 'vscode';

export type TraceOpenArgs = {
	integrationId: string;
	name: string;
	status: string;
};

/**
 * Manages a single Trace webview panel instance and switching its context
 * to a specific integration when requested.
 */
export class TracePanel {
	private static instance: TracePanel | undefined;

	private readonly context: vscode.ExtensionContext;
	private panel: vscode.WebviewPanel | undefined;
	private currentIntegration: TraceOpenArgs | undefined;

	private constructor(context: vscode.ExtensionContext) {
		this.context = context;
	}

	public static getInstance(context: vscode.ExtensionContext): TracePanel {
		if (!TracePanel.instance) {
			TracePanel.instance = new TracePanel(context);
		}
		return TracePanel.instance;
	}

	public openOrReveal(args: TraceOpenArgs): void {
		this.currentIntegration = args;

		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active, true);
			this.updateWebview();
			return;
		}

		this.panel = vscode.window.createWebviewPanel(
			'kaoto.trace',
			'Trace',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);

		this.panel.onDidDispose(() => {
			this.panel = undefined;
		});

		this.updateWebview();
	}

	private updateWebview(): void {
		if (!this.panel) {
			return;
		}

		const integration = this.currentIntegration;

		const nonce = getNonce();

		this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.panel.webview.cspSource} https:; script-src 'nonce-${nonce}'; style-src ${this.panel.webview.cspSource} 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Trace</title>
  <style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0; margin: 0; }
  header { display: flex; align-items: center; gap: .5rem; padding: .5rem .75rem; border-bottom: 1px solid var(--vscode-panel-border); }
  main { padding: .75rem; }
  .badge { font-size: 11px; padding: 2px 6px; border-radius: 12px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  </style>
  </head>
  <body>
    <header>
      <strong>Integration:</strong>
      <span id="name"></span>
      <span class="badge" id="status"></span>
      <span style="opacity:.7">(<code id="id"></code>)</span>
    </header>
    <main>
      <p>This is a placeholder for the Trace panel UI.</p>
    </main>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const integration = ${JSON.stringify(integration ?? {})};
      function render(ctx){
        document.getElementById('name').textContent = ctx?.name ?? '';
        document.getElementById('status').textContent = ctx?.status ?? '';
        document.getElementById('id').textContent = ctx?.integrationId ?? '';
      }
      render(integration);
      window.addEventListener('message', event => {
        if(event?.data?.type === 'setContext'){
          render(event.data.payload);
        }
      });
    </script>
  </body>
  </html>`;

		// also post a message so future implementations can handle dynamic updates
		this.panel.webview.postMessage({ type: 'setContext', payload: integration });
	}

	public switchContext(args: TraceOpenArgs): void {
		this.currentIntegration = args;
		this.updateWebview();
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
