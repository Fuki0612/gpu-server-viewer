import * as cp from 'child_process';
import * as xml2js from 'xml2js';

export interface GpuInfo {
    index: string;
    name: string;
    utilization: {
        gpu: string;
        memory: string;
    };
    memory: {
        total: string;
        free: string;
        used: string;
    };
    temperature: {
        gpu: string;
    };
    processes: GpuProcess[];
}

export interface GpuProcess {
    pid: string;
    user: string;
    usedMemory: string;
    elapsed: string;
}

interface PsEntry {
    user: string;
    elapsed: string;
}

// Must not start with '=': zsh expands =word to a command path
const PS_SEPARATOR = '__GPU_SERVER_VIEWER_PS__';

export class GpuMonitor {
    constructor() {}

    public async getGpuStatus(host: string): Promise<GpuInfo[]> {
        return new Promise((resolve, reject) => {
            // Use -q -x for XML output which is easier to parse than table.
            // ps is run in the same SSH session to map each GPU process's PID to its owner.
            // user:32 keeps long user names from being truncated or shown as UIDs.
            const command = `ssh ${host} 'nvidia-smi -q -x; echo ${PS_SEPARATOR}; ps -eo pid=,user:32=,etime='`;

            cp.exec(command, (error, stdout, stderr) => {
                if (error) {
                    // If ssh fails or nvidia-smi fails
                    console.error(`Error fetching GPU status for ${host}:`, error);
                    // For demo purposes, if it fails, maybe return empty or throw
                    // If the user doesn't have a GPU server, this will fail.
                    // I should probably mock this if it fails for specific "test" hosts?
                    // For now, just reject.
                    reject(error);
                    return;
                }

                const [xml, psOutput = ''] = stdout.split(PS_SEPARATOR);
                // The exit status is that of ps, so a failed nvidia-smi shows up as empty XML
                if (!xml.trim()) {
                    reject(new Error(stderr || 'nvidia-smi returned no output'));
                    return;
                }

                this.parseNvidiaSmiXml(xml, this.parsePs(psOutput))
                    .then(resolve)
                    .catch(reject);
            });
        });
    }

    private parsePs(output: string): Map<string, PsEntry> {
        const entries = new Map<string, PsEntry>();
        for (const line of output.split('\n')) {
            const [pid, user, elapsed] = line.trim().split(/\s+/);
            if (pid && user && elapsed) {
                entries.set(pid, { user, elapsed });
            }
        }
        return entries;
    }

    private parseProcesses(gpu: any, ps: Map<string, PsEntry>): GpuProcess[] {
        // <processes> is an empty string when no process is running on the GPU
        const infos = gpu.processes?.process_info;
        if (!infos) {
            return [];
        }
        const infoList = Array.isArray(infos) ? infos : [infos];
        return infoList.map((info: any) => {
            const pid = String(info.pid);
            // PIDs inside containers may not match the host's ps output
            const entry = ps.get(pid);
            return {
                pid,
                user: entry?.user ?? 'unknown',
                usedMemory: info.used_memory,
                elapsed: entry?.elapsed ?? '-'
            };
        });
    }

    private async parseNvidiaSmiXml(xml: string, ps: Map<string, PsEntry>): Promise<GpuInfo[]> {
        const parser = new xml2js.Parser({ explicitArray: false });
        try {
            const result = await parser.parseStringPromise(xml);
            const gpus = result.nvidia_smi_log.gpu;

            // Handle single GPU (object) vs multiple GPUs (array)
            const gpuList = Array.isArray(gpus) ? gpus : [gpus];

            return gpuList.map((gpu: any, index: number) => ({
                index: index.toString(),
                name: gpu.product_name,
                utilization: {
                    gpu: gpu.utilization.gpu_util,
                    memory: gpu.utilization.memory_util
                },
                memory: {
                    total: gpu.fb_memory_usage.total,
                    free: gpu.fb_memory_usage.free,
                    used: gpu.fb_memory_usage.used
                },
                temperature: {
                    gpu: gpu.temperature.gpu_temp
                },
                processes: this.parseProcesses(gpu, ps)
            }));
        } catch (e) {
            console.error('Failed to parse XML:', e);
            return [];
        }
    }
}
