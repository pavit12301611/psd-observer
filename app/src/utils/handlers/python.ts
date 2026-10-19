import { Logger } from '../logging';
import { getJupyterConfig } from './JupyterConfig'; // Fixed casing to match actual file name

/**
 * Execute Python code using a Jupyter kernel
 */
export async function executePython(
  response: string,
  agentId: string,
  code: string
): Promise<boolean> {
  Logger.debug(agentId, 'Executing Python code');
  const { host, port, token } = getJupyterConfig();

  try {
    // Lazy load Jupyter services - only loads when Python execution is used!
    const { KernelManager, ServerConnection } = await import('@jupyterlab/services');

    // Create server settings with token and CORS handling
    const serverSettings = ServerConnection.makeSettings({
      baseUrl: `http://${host}:${port}`,
      wsUrl: `ws://${host}:${port}`,
      token: token,
      init: {
        mode: 'cors',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      }
    });
    
    // Skip connection test - we'll rely on the kernel API
    
    // Create kernel manager with settings
    const kernelManager = new KernelManager({ serverSettings });
    
    // Start a new kernel directly instead of trying to list kernels first
    Logger.debug(agentId, 'Starting new kernel');
    const kernel = await kernelManager.startNew({ name: 'python3' });
    Logger.debug(agentId, `Started new kernel: ${kernel.id}`);
    
    // We already have a kernel from above
    
    // Prepare code with variables
    const fullCode = `
response = """${response.replace(/"""/g, '\\"\\"\\"')}"""
agentId = "${agentId}"
# User code begins here
${code}
`;
    
    // Execute the code
    Logger.debug(agentId, 'Executing code');
    let hasError = false;
    const future = kernel.requestExecute({ code: fullCode });
    
    // Handle messages with proper type casting
    future.onIOPub = (msg: any) => {
      const msgType = msg.header.msg_type;

      if (msgType === 'error') {
        hasError = true;
        const errorContent = msg.content;
        Logger.error(agentId, `Python error: ${errorContent.ename}: ${errorContent.evalue}`);
      } else if (msgType === 'stream') {
        const streamContent = msg.content;
        if (streamContent.name === 'stderr') {
          Logger.warn(agentId, `Python stderr: ${streamContent.text}`);
        } else if (streamContent.name === 'stdout') {
          Logger.info(agentId, `Python stdout: ${streamContent.text}`);
        }
      }
    };
    
    // Wait for execution to complete
    await future.done;
    Logger.debug(agentId, 'Code execution completed');
    await kernel.shutdown();
    
    return !hasError;
  } catch (error) {
    Logger.error(agentId, `Error executing Python: ${error}`);
    return false;
  }
}
