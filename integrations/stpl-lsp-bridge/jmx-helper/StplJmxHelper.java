/*
 * Attach to a SWC JVM and invoke the STPL LS JMX console.
 *
 * MBean ObjectName: from env STPL_JMX_OBJECT_NAME (required).
 * Ops:   start(String port), serverInfo(String user, String extensionVersion)
 *
 * Usage (JDK 11+, source-file mode):
 *   export STPL_JMX_OBJECT_NAME='domain:type=basic,name=console'
 *   java StplJmxHelper.java <pid> start <port>
 *   java StplJmxHelper.java <pid> serverInfo [user] [extensionVersion]
 *   java StplJmxHelper.java discover [user] [extensionVersion]
 *
 * serverInfo prints the MBean return value to stdout (empty if unsupported).
 * discover prints a JSON array of SWC JVMs that expose the MBean and accept serverInfo.
 * Default extensionVersion is 0.1.0 (SWC LanguageServerJMXConsole debug default).
 * stop is not supported by the MBean — exits with code 2.
 */

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

import javax.management.MBeanServerConnection;
import javax.management.ObjectName;
import javax.management.remote.JMXConnector;
import javax.management.remote.JMXConnectorFactory;
import javax.management.remote.JMXServiceURL;

import com.sun.tools.attach.VirtualMachine;
import com.sun.tools.attach.VirtualMachineDescriptor;

public class StplJmxHelper {

    private static final String OBJECT_NAME_ENV = "STPL_JMX_OBJECT_NAME";
    private static final String DEFAULT_EXTENSION_VERSION = "0.1.0";
    private static final String LOCAL_CONNECTOR_ADDRESS =
            "com.sun.management.jmxremote.localConnectorAddress";

    /** Resolved from {@link #OBJECT_NAME_ENV} in {@link #main}. */
    private static String objectName;

    public static void main(String[] args) throws Exception {
        objectName = requireObjectName();

        if (args.length < 1) {
            usageAndExit(1);
        }

        // discover [user] [extensionVersion]  — no pid
        if ("discover".equals(args[0])) {
            String user = args.length >= 2 ? args[1] : System.getProperty("user.name");
            String version = args.length >= 3 ? args[2] : DEFAULT_EXTENSION_VERSION;
            discover(user, version);
            return;
        }

        if (args.length < 2) {
            usageAndExit(1);
        }
        String pid = args[0];
        String action = args[1];

        switch (action) {
            case "start" -> {
                if (args.length < 3) {
                    System.err.println("start requires <port>");
                    usageAndExit(1);
                }
                invokeStart(pid, args[2]);
            }
            case "serverInfo" -> {
                String user = args.length >= 3 ? args[2] : System.getProperty("user.name");
                String version = args.length >= 4 ? args[3] : DEFAULT_EXTENSION_VERSION;
                String info = invokeServerInfo(pid, user, version);
                System.out.print(info == null ? "" : info);
            }
            case "stop" -> {
                System.err.println(
                        "stop is not supported: SWC MBean has no stop(); use LSP exit instead");
                System.exit(2);
            }
            default -> {
                System.err.println("unknown action: " + action);
                usageAndExit(1);
            }
        }
    }

    /**
     * Scan local JVMs for the STPL JMX console and print JSON:
     * [{"pid":"...","displayName":"...","info":"running:version:workspace"}, ...]
     */
    private static void discover(String user, String version) {
        List<String> entries = new ArrayList<>();
        String selfPid = ProcessHandle.current().pid() + "";
        for (VirtualMachineDescriptor desc : VirtualMachine.list()) {
            String pid = desc.id();
            if (pid.equals(selfPid)) {
                continue;
            }
            try {
                if (!hasStplConsole(pid)) {
                    continue;
                }
                String info = invokeServerInfo(pid, user, version);
                if (info == null || info.isEmpty()) {
                    continue;
                }
                entries.add(
                        "{\"pid\":"
                                + jsonString(pid)
                                + ",\"displayName\":"
                                + jsonString(desc.displayName())
                                + ",\"info\":"
                                + jsonString(info)
                                + "}");
            } catch (Exception ignored) {
                // Not attachable / not SWC — skip
            }
        }
        System.out.print("[" + String.join(",", entries) + "]");
    }

    private static String requireObjectName() {
        String name = System.getenv(OBJECT_NAME_ENV);
        if (name == null || name.isBlank()) {
            System.err.println(
                    OBJECT_NAME_ENV
                            + " is required (JMX MBean ObjectName, e.g. domain:type=basic,name=console)");
            System.exit(1);
        }
        return name.trim();
    }

    private static boolean hasStplConsole(String pid) throws Exception {
        return withConnection(pid, conn -> {
            ObjectName name = new ObjectName(objectName);
            return Boolean.valueOf(conn.isRegistered(name));
        });
    }

    private static String jsonString(String value) {
        if (value == null) {
            return "null";
        }
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
        return sb.toString();
    }

    private static void invokeStart(String pid, String port) throws Exception {
        withConnection(pid, conn -> {
            ObjectName name = new ObjectName(objectName);
            conn.invoke(
                    name,
                    "start",
                    new Object[] {port},
                    new String[] {String.class.getName()});
            return null;
        });
    }

    private static String invokeServerInfo(String pid, String user, String version)
            throws Exception {
        return withConnection(pid, conn -> {
            ObjectName name = new ObjectName(objectName);
            Object result = conn.invoke(
                    name,
                    "serverInfo",
                    new Object[] {user, version},
                    new String[] {String.class.getName(), String.class.getName()});
            return result == null ? "" : String.valueOf(result);
        });
    }

    @FunctionalInterface
    private interface JmxCall<T> {
        T run(MBeanServerConnection conn) throws Exception;
    }

    private static <T> T withConnection(String pid, JmxCall<T> call) throws Exception {
        VirtualMachine vm = VirtualMachine.attach(pid);
        try {
            String address = vm.getAgentProperties().getProperty(LOCAL_CONNECTOR_ADDRESS);
            if (address == null) {
                try {
                    vm.startLocalManagementAgent();
                } catch (NoSuchMethodError e) {
                    String javaHome = vm.getSystemProperties().getProperty("java.home");
                    String agent =
                            javaHome + File.separator + "lib" + File.separator + "management-agent.jar";
                    File agentFile = new File(agent);
                    if (!agentFile.isFile()) {
                        throw new IllegalStateException(
                                "Cannot start local JMX agent for pid " + pid + ": " + e.getMessage(),
                                e);
                    }
                    vm.loadAgent(agent);
                }
                address = vm.getAgentProperties().getProperty(LOCAL_CONNECTOR_ADDRESS);
            }
            if (address == null) {
                Properties props = vm.getAgentProperties();
                address = props.getProperty(LOCAL_CONNECTOR_ADDRESS);
            }
            if (address == null) {
                throw new IllegalStateException(
                        "No local JMX connector address for pid " + pid
                                + " (is this a SWC JVM?)");
            }
            JMXServiceURL url = new JMXServiceURL(address);
            try (JMXConnector connector = JMXConnectorFactory.connect(url)) {
                return call.run(connector.getMBeanServerConnection());
            }
        } finally {
            vm.detach();
        }
    }

    private static void usageAndExit(int code) {
        System.err.println(
                "Usage: java StplJmxHelper.java <pid> start <port>\n"
                        + "       java StplJmxHelper.java <pid> serverInfo [user] [extensionVersion]\n"
                        + "       java StplJmxHelper.java discover [user] [extensionVersion]\n"
                        + "Requires env "
                        + OBJECT_NAME_ENV
                        + (objectName != null ? (" (current: " + objectName + ")") : ""));
        System.exit(code);
    }
}
