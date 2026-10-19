# ollama_proxy/command_executor.py
import subprocess
import logging

logger = logging.getLogger('ollama-proxy.executor')

def execute_command_stream(command, container_name):
    """
    Executes a command in a Docker container and yields SSE-formatted output.
    This is a generator function.
    """
    # Security check: Only allow commands that start with 'ollama'
    if not command.strip().startswith("ollama"):
        logger.warning(f"Blocked potentially unsafe command: {command}")
        yield "event: error\ndata: ERROR: Only 'ollama' commands are allowed.\n\n"
        return

    docker_exec_cmd = f"docker exec {container_name} {command}"
    logger.info(f"Executing command: {docker_exec_cmd}")

    try:
        process = subprocess.Popen(
            docker_exec_cmd,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1, # Line-buffered
        )

        # Stream the output line by line
        for line in iter(process.stdout.readline, ''):
            data = line.rstrip()
            logger.debug(f"Exec output line: {data}")
            yield f"data: {data}\n\n"

        process.stdout.close()
        return_code = process.wait()
        logger.info(f"Command '{command}' finished with exit code {return_code}")
        yield f"event: done\ndata: [COMMAND_FINISHED code={return_code}]\n\n"

    except FileNotFoundError:
        error_msg = "ERROR: 'docker' command not found. Is Docker installed and in your PATH?"
        logger.error(error_msg)
        yield f"event: error\ndata: {error_msg}\n\n"

    except Exception as e:
        logger.error(f"Error executing command '{command}': {e}")
        error_msg = str(e).replace('\n', ' ')
        yield f"event: error\ndata: ERROR: {error_msg}\n\n"
