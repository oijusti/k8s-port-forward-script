/**
 * Kubernetes Port Forward – Script
 *
 * @version 0.0.4
 * @date 2024-08-30
 * @license MIT
 * @repository https://github.com/oijusti/k8s-port-forward-script
 * @description Kubernetes Port Forward (Script): lists Kubernetes services by fetching pod details
 *   using kubectl and allows the user to forward ports for a selected service.
 *
 * @usage
 *   Basic Usage: node ./k8s-port-forward-script.js
 *   With Namespace: node ./k8s-port-forward-script.js --namespace <NAMESPACE>
 */

const metadata = {
  version: "0.0.4",
  date: "2024-08-30",
  license: "MIT",
  repository: "https://github.com/oijusti/k8s-port-forward-script",
};

const { exec, spawn } = require("child_process");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const spinner = new Spinner();

const c = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

/**
 * Helpers
 */

function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else if (stderr) {
        reject(new Error(stderr));
      } else {
        resolve(stdout);
      }
    });
  });
}

function parseServicesMap(podsData, namespace) {
  const servicesMap = new Map();
  const lines = podsData.trim().split("\n");

  // Get headers to find indices
  const headers = lines[0].split(/\s+/);
  const namespaceIndex = headers.indexOf("NAMESPACE");
  const nameIndex = headers.indexOf("NAME");
  const statusIndex = headers.indexOf("STATUS");

  for (let i = 1; i < lines.length; i++) {
    const columns = lines[i].split(/\s+/);

    // Read STATUS column (if present) and skip non-Running entries
    const statusColumn = statusIndex !== -1 ? columns[statusIndex] : undefined;
    if (statusColumn !== undefined && statusColumn !== "Running") {
      continue;
    }

    const namespaceColumn = namespace ?? columns[namespaceIndex];
    const nameColumn = columns[nameIndex];

    // Categorize services by environment based on prefix: "dev-", "qa-", "stg-", "prod-", or "default"
    const envPrefixes = ["dev", "qa", "stg", "prod"];
    const envPrefix =
      envPrefixes.find((env) => nameColumn.startsWith(`${env}-`)) ?? "default";

    const parts = nameColumn.split("-");
    if (parts.length > 2) {
      const serviceName = parts.slice(0, -2).join("-");
      const serviceId = parts.slice(-2).join("-");

      const envPrefixStripRegex = new RegExp(`^(${envPrefixes.join("|")})-`);
      let shortServiceName = serviceName.replace(envPrefixStripRegex, "");
      if (namespaceColumn) {
        shortServiceName = shortServiceName.replace(
          new RegExp(`^${namespaceColumn}-`, "g"),
          "",
        );
      }

      if (!servicesMap.has(shortServiceName)) {
        servicesMap.set(shortServiceName, {});
      }
      servicesMap.get(shortServiceName)[envPrefix] = {
        id: serviceId,
        namespace: namespaceColumn,
        serviceName,
      };
    }
  }
  return servicesMap;
}

function getArgValue(flag) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) {
      return args[i + 1];
    }
  }
  return null;
}

function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function colorText(colorCode, text) {
  const reset = "\x1b[0m";
  return `${colorCode}${text}${reset}`;
}

function print(colorCode, text) {
  return console.log(colorText(colorCode, text));
}

// function sleep(ms) {
//   return new Promise((resolve) => setTimeout(resolve, ms));
// }

function isValidPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

function nextAvailablePort(startPort, reservedPorts) {
  let p = startPort;
  while (reservedPorts.has(String(p))) p++;
  return String(p);
}

// Parses a selection string like: "1,3,5" (1-based indices)
function parseMultiSelect(input, max) {
  const raw = String(input ?? "").trim();
  if (!raw) return [];

  const result = new Set();
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  for (const part of parts) {
    const n = Number.parseInt(part, 10);
    if (!Number.isFinite(n) || n < 1 || n > max) return null;
    result.add(n);
  }

  return Array.from(result).sort((x, y) => x - y);
}

function writePrefixedLines(colorCode, prefix, data) {
  const text = data instanceof Buffer ? data.toString("utf8") : String(data);
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Avoid printing a trailing empty line produced by split when input ends with newline
    if (i === lines.length - 1 && line === "") continue;
    process.stdout.write(colorText(colorCode, `${prefix} ${line}`) + "\n");
  }
}

function Spinner() {
  const spinnerChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let index = 0;
  let intervalId = null;
  let message = "";

  return {
    start(newMessage) {
      if (intervalId) return; // Spinner is already running

      message = newMessage;
      process.stdout.write(`${message}...`); // Write the message first

      intervalId = setInterval(() => {
        process.stdout.write(`\r${message}...${spinnerChars[index]}`);
        index = (index + 1) % spinnerChars.length;
      }, 100); // Adjust the speed by changing the interval (in milliseconds)
    },

    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        process.stdout.write(`\r${message}...done.\n`); // Overwrite the spinner with "done."
      }
    },
  };
}

function attachGracefulShutdown({ rl, processes, print, c }) {
  let isShuttingDown = false;

  const killPortForwardProcess = (p) => {
    if (!p || !p.pid) return;

    // Best-effort: try to stop kubectl and, on Windows, also kill the full process tree.
    try {
      if (process.platform === "win32") {
        try {
          p.kill();
        } catch {
          // ignore
        }

        try {
          const killer = spawn(
            "taskkill",
            ["/PID", String(p.pid), "/T", "/F"],
            { stdio: "ignore" },
          );
          killer.unref();
        } catch {
          // ignore
        }
      } else {
        try {
          p.kill("SIGINT");
        } catch {
          // ignore
        }

        // If it doesn't exit quickly, force kill it.
        const t = setTimeout(() => {
          try {
            p.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 1500);
        if (typeof t.unref === "function") t.unref();
      }
    } catch {
      // ignore
    }
  };

  const shutdown = (reason) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    if (reason) print(c.cyan, `\nShutting down (${reason})...`);

    try {
      rl.close();
    } catch {
      // ignore
    }

    for (const p of processes) {
      killPortForwardProcess(p);
    }

    // Ensure we actually exit (especially on Windows where handles can linger).
    const t = setTimeout(() => process.exit(0), 200);
    if (typeof t.unref === "function") t.unref();
  };

  process.once("SIGINT", () => shutdown("SIGINT / Ctrl+C"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  return shutdown;
}

// Open logs in an external terminal when possible, otherwise spawn in current process.
function openLogsInTerminal(logsCommand, logsTitle) {
  // Escape backslashes and double quotes for shell/AppleScript
  const escapedCommand = logsCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedTitle = logsTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  if (process.platform === "win32") {
    // Open a new cmd window with a title and run the logs command (keeps window open)
    exec(`start "${escapedTitle}" cmd.exe /k "${logsCommand}"`, (err) => {
      if (err) {
        console.error(`Failed to open terminal: ${err.message}`);
        spawn("kubectl", logsCommand.split(" ").slice(1), { stdio: "inherit" });
      }
    });
  } else if (process.platform === "darwin") {
    // Open a new Terminal window on macOS
    // Use AppleScript with multiple -e arguments for proper parsing
    // Use osascript with multiple -e arguments (each -e is a separate line of AppleScript)
    const args = [
      "-e", `tell application "Terminal"`,
      "-e", `set newTab to do script "${escapedCommand}"`,
      "-e", `set custom title of newTab to "${escapedTitle}"`,
      "-e", "activate",
      "-e", "end tell"
    ];

    const child = spawn("osascript", args, { stdio: ["ignore", "pipe", "pipe"] });
    
    let stderrData = "";
    child.stderr.on("data", (data) => {
      stderrData += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.error(`Failed to open Terminal (exit code ${code})`);
        if (stderrData) console.error(`stderr: ${stderrData}`);
        // Fallback to spawning in current process
        spawn("kubectl", logsCommand.split(" ").slice(1), { stdio: "inherit" });
      }
    });

    child.on("error", (err) => {
      console.error(`Failed to execute osascript: ${err.message}`);
      spawn("kubectl", logsCommand.split(" ").slice(1), { stdio: "inherit" });
    });
  } else {
    // Try common Linux terminals; set the title via escape sequence or terminal option; fall back to spawning in current process
    const commandWithTitle = `echo -ne '\\033]0;${escapedTitle}\\007'; ${escapedCommand}`;

    exec(
      `gnome-terminal -- bash -c "${commandWithTitle}; exec bash"`,
      (err) => {
        if (err) {
          exec(
            `x-terminal-emulator -e bash -c "${commandWithTitle}; exec bash"`,
            (err2) => {
              if (err2) {
                exec(
                  `xterm -T "${escapedTitle}" -e bash -c "${escapedCommand}; exec bash"`,
                  (err3) => {
                    if (err3) {
                      console.error(`Failed to open terminal: ${err3.message}`);
                      spawn("kubectl", logsCommand.split(" ").slice(1), {
                        stdio: "inherit",
                      });
                    }
                  },
                );
              }
            },
          );
        }
      },
    );
  }
}

async function getNamespaces() {
  const getNamespacesCommand =
    "kubectl get namespaces -o jsonpath={.items[*].metadata.name}";

  print(c.green, `\n> ${getNamespacesCommand}`);
  spinner.start("Loading namespaces");

  const nsOutput = await execPromise(getNamespacesCommand);
  const namespaces = nsOutput.trim().split(/\s+/);
  spinner.stop();

  return namespaces;
}

async function getPods(namespace) {
  const getPodsCommand = namespace
    ? `kubectl get pods --namespace ${namespace}`
    : "kubectl get pods --all-namespaces";

  print(c.green, `\n> ${getPodsCommand}`);
  spinner.start("Loading services");

  const podsData = await execPromise(getPodsCommand);
  spinner.stop();

  return podsData;
}

async function getServicePort(serviceNamespace, serviceName) {
  const getServicePortCommand = `kubectl get service --namespace ${serviceNamespace} ${serviceName} -o jsonpath={.spec.ports[*].port}`;
  print(c.green, `\n> ${getServicePortCommand}`);

  spinner.start("Detecting port on the Kubernetes service");
  try {
    const servicePortDetected = await execPromise(getServicePortCommand);
    spinner.stop();
    print(c.cyan, `Port detected: ${servicePortDetected}\n`);
    return servicePortDetected;
  } catch (error) {
    spinner.stop();
    console.error(`Error detecting port: ${error}`);
    return "3000"; // Default value if detection fails
  }
}

const main = async () => {
  print(c.yellow, "☸️  Kubernetes Port Forward – Script");
  print(c.cyan, metadata.repository);
  print(c.cyan, `Version: ${metadata.version}`);
  print(c.cyan, "Usage:");
  print(c.cyan, "  node ./k8s-port-forward-script.js");
  print(c.cyan, "  node ./k8s-port-forward-script.js --namespace <NAMESPACE>");

  try {
    let namespace = getArgValue("--namespace");

    if (!namespace) {
      // Get namespaces
      const namespaces = await getNamespaces();

      if (namespaces.length === 0) {
        print(c.magenta, "No namespaces found.");
        rl.close();
        return;
      }

      print(c.magenta, "\nNamespaces found:");
      namespaces.forEach((ns, index) => {
        print(c.green, `[${index + 1}] ${ns}`);
      });

      const nsAnswer = await prompt(
        colorText(
          c.yellow,
          "Select a namespace by typing a number (default: --all-namespaces): ",
        ),
      );
      const nsIndex = parseInt(nsAnswer) || 0;

      if (isNaN(nsIndex) || nsIndex < 0 || nsIndex > namespaces.length) {
        console.error(
          "Invalid selection. Please run the script again and choose a valid number.",
        );
        rl.close();
        return;
      }

      namespace = nsIndex > 0 ? namespaces[nsIndex - 1] : undefined;
      print(
        c.cyan,
        `You selected namespace: ${namespace ? namespace : "--all-namespaces"}`,
      );
    }

    // Get pods
    const podsData = await getPods(namespace);

    // Process services
    const servicesMap = parseServicesMap(podsData, namespace);
    const servicesList = Array.from(servicesMap.keys()).sort();

    if (servicesList.length === 0) {
      print(c.magenta, "No services found.");
      rl.close();
      return;
    }

    print(c.magenta, "\nServices found:");
    servicesList.forEach((service, index) => {
      print(c.green, `[${index + 1}] ${service}`);
    });

    const serviceAnswer = await prompt(
      colorText(
        c.yellow,
        "Select one or more services by typing numbers (e.g. 1,3,5): ",
      ),
    );

    const selectedNumbers = parseMultiSelect(
      serviceAnswer,
      servicesList.length,
    );
    if (!selectedNumbers || selectedNumbers.length === 0) {
      console.error(
        "Invalid selection. Please run the script again and choose valid numbers (e.g. 1,3,5).",
      );
      rl.close();
      return;
    }

    const selectedServices = selectedNumbers.map((n) => servicesList[n - 1]);
    print(
      c.cyan,
      `You selected (${selectedServices.length}): ${selectedServices.join(
        ", ",
      )}`,
    );

    // Collect configs for all selected services first (so we can run port-forwards together)
    const selectedConfigs = [];
    const reservedLocalPorts = new Set();

    for (const selectedService of selectedServices) {
      print(c.magenta, `\n--- ${selectedService} ---`);
      const availableEnvs = Object.keys(servicesMap.get(selectedService) || {});
      if (availableEnvs.length === 0) {
        print(c.red, `No environments found for ${selectedService}. Skipping.`);
        continue;
      }

      print(c.magenta, "Environments:");
      availableEnvs.forEach((env, index) => {
        print(c.green, `[${index + 1}] ${env}`);
      });

      const envAnswer = await prompt(
        colorText(
          c.yellow,
          `Select an environment for ${selectedService} (default: 1): `,
        ),
      );
      const envChoice = Number.parseInt(envAnswer, 10) || 1;
      if (envChoice < 1 || envChoice > availableEnvs.length) {
        print(
          c.red,
          `Invalid environment selection for ${selectedService}. Skipping.`,
        );
        continue;
      }

      const environment = availableEnvs[envChoice - 1];
      const serviceDetails = servicesMap.get(selectedService)[environment];
      if (!serviceDetails) {
        print(
          c.red,
          `The selected environment "${environment}" does not exist for "${selectedService}". Skipping.`,
        );
        continue;
      }

      const serviceId = serviceDetails.id;
      const serviceName = serviceDetails.serviceName;
      const serviceNamespace = namespace ?? serviceDetails.namespace;
      const envLabel = environment !== "default" ? `${environment}~` : "";

      const suggestedLocalPort = nextAvailablePort(3000, reservedLocalPorts);
      let localPort = "";
      while (true) {
        const localPortAnswer = await prompt(
          colorText(
            c.yellow,
            `Enter the local port for ${envLabel}${selectedService} (default: ${suggestedLocalPort}): `,
          ),
        );
        localPort = localPortAnswer || suggestedLocalPort;
        if (!isValidPort(localPort)) {
          print(c.red, "Invalid port. Enter a number between 1 and 65535.");
          continue;
        }
        if (reservedLocalPorts.has(localPort)) {
          print(
            c.red,
            `Port ${localPort} is already used by another selection. Choose another.`,
          );
          continue;
        }
        reservedLocalPorts.add(localPort);
        break;
      }

      const servicePortDetected = await getServicePort(
        serviceNamespace,
        serviceName,
      );
      const servicePortAnswer = await prompt(
        colorText(
          c.yellow,
          `Enter the destination port on the Kubernetes service for ${envLabel}${selectedService} (default: ${servicePortDetected}): `,
        ),
      );
      const servicePort = servicePortAnswer || `${servicePortDetected}`;
      if (!isValidPort(servicePort)) {
        print(
          c.red,
          `Invalid destination port for ${selectedService}. Using detected/default: ${servicePortDetected}`,
        );
      }

      const logsAnswer = await prompt(
        colorText(
          c.yellow,
          `Would you like to see the logs in real time for ${envLabel}${selectedService}? (Y/n): `,
        ),
      );
      const logsChoice = (logsAnswer.toLowerCase() || "y").trim();
      const showLogs =
        logsChoice === "y" || logsChoice === "yes" || logsChoice === "";

      selectedConfigs.push({
        selectedService,
        environment,
        envLabel,
        serviceId,
        serviceName,
        serviceNamespace,
        localPort,
        servicePort: servicePortAnswer ? servicePort : `${servicePortDetected}`,
        showLogs,
      });
    }

    if (selectedConfigs.length === 0) {
      print(c.magenta, "No services selected/configured.");
      rl.close();
      return;
    }

    // Open logs windows first (optional)
    for (const cfg of selectedConfigs) {
      if (!cfg.showLogs) continue;

      const podName = `${cfg.serviceName}-${cfg.serviceId}`;
      const logsCommand = `kubectl logs --namespace ${cfg.serviceNamespace} ${podName} -f`;
      print(c.green, `\n> ${logsCommand}`);
      print(
        c.cyan,
        `Opening logs in a separate window (${cfg.envLabel}${cfg.selectedService}:${cfg.localPort})`,
      );
      const logsTitle = `${cfg.envLabel}${cfg.selectedService}:${cfg.localPort}`;
      openLogsInTerminal(logsCommand, logsTitle);
    }

    // Start all port-forwards in this same terminal
    const portForwardProcesses = [];
    attachGracefulShutdown({
      rl,
      processes: portForwardProcesses,
      print,
      c,
    });

    print(c.reset, "\nInitializing port forwarding (all in this terminal)");
    for (const cfg of selectedConfigs) {
      const podName = `${cfg.serviceName}-${cfg.serviceId}`;
      const portForwardArgs = [
        "port-forward",
        "--namespace",
        cfg.serviceNamespace,
        podName,
        `${cfg.localPort}:${cfg.servicePort}`,
      ];

      const portForwardCommand = `kubectl ${portForwardArgs.join(" ")}`;
      const prefix = `[${cfg.envLabel}${cfg.selectedService}:${cfg.localPort}]`;
      print(c.green, `\n> ${portForwardCommand}`);

      const p = spawn("kubectl", portForwardArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      portForwardProcesses.push(p);

      let printedAvailable = false;
      p.stdout.on("data", (data) => {
        if (!printedAvailable) {
          printedAvailable = true;
          writePrefixedLines(
            c.magenta,
            prefix,
            `Service available at: http://localhost:${cfg.localPort}`,
          );
        }
        writePrefixedLines(c.green, prefix, data);
      });

      p.stderr.on("data", (data) => {
        writePrefixedLines(c.red, prefix, data);
      });

      p.on("close", (code) => {
        writePrefixedLines(
          c.cyan,
          prefix,
          `port-forward exited with code ${code}`,
        );
      });
    }

    // No more user input required once port-forwards are running
    rl.close();
  } catch (error) {
    spinner.stop();
    console.error(`${error.message}`);
    rl.close();
  }
};

main();
