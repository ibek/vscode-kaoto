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
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

export type TraceStatus = 'idle' | 'running' | 'stopped' | 'error';

type IntegrationTraceProcess = {
	dumpProc: ChildProcessWithoutNullStreams;
	status: TraceStatus;
	buffer: string;
};

export type TraceLineEvent = { integrationId: string; line: string };

/**
 * Controls start/stop of tracing for a given integration and streams dump output line-by-line.
 */
export class TraceManager implements vscode.Disposable {
	private readonly jbangExecutable: string;
	private readonly camelJBangVersion: string;
	private readonly integrationIdToProcess: Map<string, IntegrationTraceProcess> = new Map();
	private readonly onDidAppendLineEmitter = new vscode.EventEmitter<TraceLineEvent>();

	public readonly onDidAppendLine: vscode.Event<TraceLineEvent> = this.onDidAppendLineEmitter.event;

	constructor(jbangExecutable: string = 'jbang') {
		this.jbangExecutable = jbangExecutable;
		this.camelJBangVersion = (vscode.workspace.getConfiguration().get('kaoto.camelJBang.Version') as string) ?? '4.13.0';
	}

	public isRunning(integrationId: string): boolean {
		const entry = this.integrationIdToProcess.get(integrationId);
		return !!entry && entry.status === 'running' && !entry.dumpProc.killed;
	}

	public async start(integrationId: string): Promise<void> {
		if (this.isRunning(integrationId)) {
			return; // already running and dump is active
		}

		// 1) enable trace on the integration
		await this.execCamelTrace(integrationId, 'start');

		// 2) spawn dump process if not already
		if (!this.integrationIdToProcess.has(integrationId)) {
			const dumpProc = this.spawnCamelTrace(integrationId, 'dump');
			const entry: IntegrationTraceProcess = { dumpProc, status: 'running', buffer: '' };
			this.integrationIdToProcess.set(integrationId, entry);
			this.attachDumpHandlers(integrationId, entry);
		}
	}

	public async stop(integrationId: string): Promise<void> {
		const entry = this.integrationIdToProcess.get(integrationId);
		if (entry) {
			try {
				entry.status = 'stopped';
				// best-effort terminate
				if (!entry.dumpProc.killed) {
					entry.dumpProc.kill();
				}
			} catch {
				// ignore
			} finally {
				this.integrationIdToProcess.delete(integrationId);
			}
		}
		await this.execCamelTrace(integrationId, 'stop');
	}

	public dispose(): void {
		for (const [integrationId, entry] of this.integrationIdToProcess.entries()) {
			try {
				entry.status = 'stopped';
				if (!entry.dumpProc.killed) {
					entry.dumpProc.kill();
				}
			} catch {
				// ignore
			} finally {
				this.integrationIdToProcess.delete(integrationId);
			}
		}
		this.onDidAppendLineEmitter.dispose();
	}

	private attachDumpHandlers(integrationId: string, entry: IntegrationTraceProcess): void {
		entry.dumpProc.stdout.on('data', (chunk: Buffer) => {
			entry.buffer += chunk.toString('utf8');
			let newlineIndex = entry.buffer.indexOf('\n');
			while (newlineIndex >= 0) {
				const line = entry.buffer.substring(0, newlineIndex).replace(/\r$/, '');
				entry.buffer = entry.buffer.substring(newlineIndex + 1);
				if (line.length > 0) {
					this.onDidAppendLineEmitter.fire({ integrationId, line });
				}
				newlineIndex = entry.buffer.indexOf('\n');
			}
		});

		entry.dumpProc.stderr.on('data', (chunk: Buffer) => {
			// treat stderr lines as trace lines too; consumers may filter/separate
			const line = chunk.toString('utf8').trim();
			if (line) {
				this.onDidAppendLineEmitter.fire({ integrationId, line });
			}
		});

		entry.dumpProc.on('close', () => {
			const current = this.integrationIdToProcess.get(integrationId);
			if (current && current.dumpProc === entry.dumpProc) {
				current.status = 'stopped';
				this.integrationIdToProcess.delete(integrationId);
			}
		});

		entry.dumpProc.on('error', () => {
			const current = this.integrationIdToProcess.get(integrationId);
			if (current && current.dumpProc === entry.dumpProc) {
				current.status = 'error';
				this.integrationIdToProcess.delete(integrationId);
			}
		});
	}

	private async execCamelTrace(integrationId: string, action: 'start' | 'stop'): Promise<void> {
		await new Promise<void>((resolve) => {
			const proc = this.spawnCamelTrace(integrationId, action);
			proc.on('close', () => resolve());
			proc.on('error', () => resolve());
		});
	}

	private spawnCamelTrace(integrationId: string, action: 'start' | 'stop' | 'dump'): ChildProcessWithoutNullStreams {
		const args = [`-Dcamel.jbang.version=${this.camelJBangVersion}`, 'camel@apache/camel', 'trace', integrationId, `--action=${action}`];
		const child = spawn(this.jbangExecutable, args, {
			env: process.env,
			// use 'pipe' for stdin/stdout/stderr so the returned type is ChildProcessWithoutNullStreams
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return child;
	}
}
