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

		this.bootstrapWebview();
	}

	private updateWebview(): void {
		if (!this.panel) {
			return;
		}

		// tell the webview the latest context
		this.panel.webview.postMessage({ type: 'trace/status', payload: this.currentIntegration });
	}

	private bootstrapWebview(): void {
		if (!this.panel) {
			return;
		}

		const webview = this.panel.webview;
		const nonce = getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'trace', 'main.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'trace', 'styles.css'));
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'trace', 'index.html');
		const cspSource = webview.cspSource;

		vscode.workspace.fs.readFile(htmlPath).then((buf) => {
			let html = Buffer.from(buf).toString('utf8');
			html = html.replace(/%SCRIPT_URI%/g, scriptUri.toString());
			html = html.replace(/%STYLE_URI%/g, styleUri.toString());
			html = html.replace(/%NONCE%/g, nonce);
			html = html.replace(/%CSP_SOURCE%/g, cspSource);
			webview.html = html;
			// push initial context
			this.updateWebview();
		});

		// message wiring: webview -> extension
		webview.onDidReceiveMessage(async (msg) => {
			const type = msg?.type as string;
			const payload = msg?.payload as { integrationId?: string } | undefined;
			switch (type) {
				case 'trace/start':
					await vscode.commands.executeCommand('trace/start', payload?.integrationId ?? this.currentIntegration?.integrationId);
					break;
				case 'trace/stop':
					await vscode.commands.executeCommand('trace/stop', payload?.integrationId ?? this.currentIntegration?.integrationId);
					break;
				case 'trace/clear':
					await vscode.commands.executeCommand('trace/clear', payload?.integrationId ?? this.currentIntegration?.integrationId);
					break;
				default:
					break;
			}
		});
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
