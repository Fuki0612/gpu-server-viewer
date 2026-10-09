import * as vscode from 'vscode';
import { GpuMonitor, GpuInfo } from './gpuMonitor';
import { GpuServerProvider } from './serverProvider';

interface MemoryHistory {
    timestamp: number;
    used: number;
    total: number;
}

export class GpuViewPanel {
    public static currentPanel: GpuViewPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _host: string | undefined; // undefined means dashboard mode (all servers)
    private _monitor: GpuMonitor;
    private _timer: NodeJS.Timeout | undefined;
    
    // History state: host -> gpuIndex -> history[]
    private _memoryHistory: Map<string, Map<string, MemoryHistory[]>> = new Map();

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, host: string | undefined) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._host = host;
        this._monitor = new GpuMonitor();

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'refresh':
                        this._update();
                        return;
                    case 'connect':
                        vscode.commands.executeCommand('gpu-server-viewer.connectSsh', message.host);
                        return;
                }
            },
            null,
            this._disposables
        );

        // Auto-refresh based on configuration
        this._setupAutoRefresh();

        // Listen for configuration changes
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('gpu-server-viewer.autoRefresh') ||
                    e.affectsConfiguration('gpu-server-viewer.refreshInterval')) {
                    this._setupAutoRefresh();
                }
            })
        );
    }

    private _setupAutoRefresh() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = undefined;
        }

        const config = vscode.workspace.getConfiguration('gpu-server-viewer');
        const autoRefresh = config.get<boolean>('autoRefresh', true);
        const interval = config.get<number>('refreshInterval', 5);

        if (autoRefresh) {
            this._timer = setInterval(() => this._update(), interval * 1000);
        }
    }

    public static createOrShow(extensionUri: vscode.Uri, host?: string) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        // Note: We might want to support multiple panels for different servers.
        // For now, let's just replace the current one or create a new one if it's a different host?
        // Or allow multiple? The spec doesn't strictly say. "Tabs" implies standard VSCode tabs.
        // Let's allow multiple panels.
        
        const title = host ? `GPU: ${host}` : 'GPU Dashboard';

        const panel = vscode.window.createWebviewPanel(
            'gpuView',
            title,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')]
            }
        );

        new GpuViewPanel(panel, extensionUri, host);
    }

    public dispose() {
        GpuViewPanel.currentPanel = undefined;

        if (this._timer) {
            clearInterval(this._timer);
        }

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async _update() {
        const webview = this._panel.webview;
        
        try {
            let data: { host: string, gpus: GpuInfo[], error?: string }[] = [];

            if (this._host) {
                try {
                    const gpus = await this._monitor.getGpuStatus(this._host);
                    this._updateHistory(this._host, gpus);
                    data.push({ host: this._host, gpus });
                } catch (e) {
                    data.push({ host: this._host, gpus: [], error: (e as Error).message });
                }
            } else {
                // Dashboard mode: fetch all
                const hosts = GpuServerProvider.getHosts();
                const promises = hosts.map(async h => {
                    try {
                        const gpus = await this._monitor.getGpuStatus(h.host);
                        this._updateHistory(h.host, gpus);
                        return { host: h.host, gpus };
                    } catch (e) {
                        return { host: h.host, gpus: [], error: (e as Error).message };
                    }
                });
                data = await Promise.all(promises);
            }

            this._panel.webview.html = this._getHtmlForWebview(webview, data);
        } catch (error) {
            // Should not happen if we catch individual errors above, but just in case
            this._panel.webview.html = this._getHtmlForWebview(webview, [], error as Error);
        }
    }

    private _updateHistory(host: string, gpus: GpuInfo[]) {
        if (!this._memoryHistory.has(host)) {
            this._memoryHistory.set(host, new Map());
        }
        const hostHistory = this._memoryHistory.get(host)!;

        const now = Date.now();
        gpus.forEach(gpu => {
            if (!hostHistory.has(gpu.index)) {
                hostHistory.set(gpu.index, []);
            }
            const history = hostHistory.get(gpu.index)!;
            
            // Parse memory used/total (assuming "1234 MiB" format)
            const used = parseInt(gpu.memory.used.replace(/\D/g, '')) || 0;
            const total = parseInt(gpu.memory.total.replace(/\D/g, '')) || 0;

            history.push({ timestamp: now, used, total });

            // Keep last 60 points (5 minutes at 5s interval)
            if (history.length > 60) {
                history.shift();
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview, data: { host: string, gpus: GpuInfo[], error?: string }[], globalError?: Error) {
        const isDashboard = !this._host;
        const title = this._host ? `GPU: ${this._host}` : 'GPU Dashboard';
        const content = this._getContent(data, globalError, isDashboard);
        
        return this._getWebviewContent(title, content, isDashboard);
    }

    private _getContent(data: { host: string, gpus: GpuInfo[], error?: string }[], globalError: Error | undefined, isDashboard: boolean): string {
        if (globalError) {
            return `<div class="error"><h3>Error fetching GPU status</h3><p>${globalError.message}</p></div>`;
        }
        
        if (data.length === 0) {
            return `<div>No servers found. Please check your SSH configuration or extension settings.</div>`;
        }

        const serverCards = data.map(server => this._getServerCardHtml(server, isDashboard)).join('');
        return `<div class="dashboard-grid">${serverCards}</div>`;
    }

    private _getServerCardHtml(server: { host: string, gpus: GpuInfo[], error?: string }, isDashboard: boolean): string {
        let serverContent = '';
        if (server.error) {
            serverContent = `<div class="error">Error: ${server.error}</div>`;
        } else if (server.gpus.length === 0) {
            serverContent = `<div>No GPUs found.</div>`;
        } else {
            serverContent = server.gpus.map(gpu => this._getGpuCardHtml(gpu, isDashboard)).join('');
        }

        return `
        <div class="server-card">
            <div class="header" style="margin-bottom: 5px;">
                <h2>${server.host}</h2>
                <button onclick="connect('${server.host}')">Connect</button>
            </div>
            ${serverContent}
        </div>
        `;
    }

    private _getGpuCardHtml(gpu: GpuInfo, isDashboard: boolean): string {
        const memUsed = parseFloat(gpu.memory.used.replace(/\D/g, ''));
        const memTotal = parseFloat(gpu.memory.total.replace(/\D/g, ''));
        const memPercent = (memUsed / memTotal) * 100;

        let details = '';
        if (!isDashboard) {
            details = `
            <div class="stat-row">
                <span>GPU: ${gpu.utilization.gpu}</span>
                <span>Temp: ${gpu.temperature.gpu}</span>
            </div>
            <div class="stat-row">
                <span>Mem Util: ${gpu.utilization.memory}</span>
            </div>
            `;
        }

        // The detail view already shows the temperature in its stat rows
        const headerTemp = isDashboard ? `<span class="temp">${gpu.temperature.gpu}</span>` : '';

        return `
        <div class="gpu-card">
            <div class="gpu-header">
                <h3>${gpu.name} [${gpu.index}]</h3>
                ${headerTemp}
            </div>
            ${details}
            <div style="margin-top: 4px;">
                <div class="memory-text">Mem: ${gpu.memory.used} / ${gpu.memory.total}</div>
                <div class="bar-container">
                    <div class="bar" style="width: ${memPercent}%"></div>
                </div>
            </div>
            ${this._getProcessTableHtml(gpu)}
        </div>
        `;
    }

    private _getProcessTableHtml(gpu: GpuInfo): string {
        if (gpu.processes.length === 0) {
            return '';
        }
        const rows = gpu.processes.map(p => `
            <tr>
                <td>${escapeHtml(p.user)}</td>
                <td class="num">${escapeHtml(p.usedMemory)}</td>
                <td class="num">${escapeHtml(p.elapsed)}</td>
            </tr>
        `).join('');
        return `
            <table class="process-table">
                <tr><th>User</th><th class="num">Mem</th><th class="num">Time</th></tr>
                ${rows}
            </table>
        `;
    }

    private _getWebviewContent(title: string, content: string, isDashboard: boolean): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title}</title>
            <style>${this._getCss(isDashboard)}</style>
        </head>
        <body>
            <div class="header">
                <h1>${title}</h1>
                <button onclick="refresh()">Refresh</button>
            </div>
            ${content}
            <script>
                const vscode = acquireVsCodeApi();
                function refresh() {
                    vscode.postMessage({ command: 'refresh' });
                }
                function connect(host) {
                    vscode.postMessage({ command: 'connect', host: host });
                }
            </script>
        </body>
        </html>`;
    }

    private _getCss(isDashboard: boolean): string {
        const gridColumns = isDashboard ? '1fr 1fr' : '1fr';
        return `
            body { font-family: sans-serif; padding: 10px; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
            .dashboard-grid { display: grid; grid-template-columns: ${gridColumns}; gap: 10px; }
            .server-card { border: 1px solid var(--vscode-widget-border); padding: 10px; border-radius: 5px; background-color: var(--vscode-editor-widget-background); }
            .gpu-card { border: 1px solid var(--vscode-widget-border); padding: 8px; margin-top: 8px; border-radius: 3px; background-color: var(--vscode-editor-background); }
            .bar-container { background-color: var(--vscode-widget-shadow); height: 8px; width: 100%; border-radius: 4px; overflow: hidden; margin-top: 4px; }
            .bar { height: 100%; background-color: var(--vscode-charts-blue); }
            .error { color: var(--vscode-errorForeground); }
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
            button { padding: 4px 8px; cursor: pointer; background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; }
            button:hover { background-color: var(--vscode-button-hoverBackground); }
            h1 { font-size: 1.2em; margin: 0; }
            h2 { font-size: 1em; margin: 0; }
            h3 { font-size: 0.9em; margin: 0 0 4px 0; }
            .stat-row { display: flex; justify-content: space-between; font-size: 0.85em; margin-bottom: 2px; }
            .memory-text { font-size: 0.85em; }
            .gpu-header { display: flex; justify-content: space-between; align-items: baseline; }
            .temp { font-size: 0.85em; }
            .process-table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 0.8em; }
            .process-table th { text-align: left; font-weight: normal; opacity: 0.7; border-bottom: 1px solid var(--vscode-widget-border); }
            .process-table td, .process-table th { padding: 1px 4px; }
            .process-table .num { text-align: right; }
        `;
    }
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
