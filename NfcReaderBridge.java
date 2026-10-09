import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import javax.smartcardio.Card;
import javax.smartcardio.CardException;
import javax.smartcardio.CardTerminal;
import javax.smartcardio.CommandAPDU;
import javax.smartcardio.ResponseAPDU;
import javax.smartcardio.TerminalFactory;

/** Reads NFC UIDs directly through Windows PC/SC and forwards scans to the local Node app. */
public final class NfcReaderBridge {
    private static final String BRIDGE_TOKEN = System.getenv("NFC_BRIDGE_TOKEN");
    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .build();
    private static volatile boolean running = true;
    private static long lastHeartbeat;

    private NfcReaderBridge() { }

    public static void main(String[] args) throws Exception {
        String serverUrl = args.length > 0 ? args[0] : "http://127.0.0.1:3000";
        Runtime.getRuntime().addShutdownHook(new Thread(() -> running = false));

        List<CardTerminal> terminals = TerminalFactory.getDefault().terminals().list();
        if (terminals.isEmpty()) {
            System.err.println("No PC/SC readers found. Connect the reader and check its Windows smart-card driver/service.");
            System.exit(1);
        }

        for (int i = 0; i < terminals.size(); i++) {
            System.out.println("Reader " + (i + 1) + ": " + terminals.get(i).getName());
        }
        CardTerminal terminal = terminals.get(0);
        System.out.println("Using reader: " + terminal.getName());
        System.out.println("Forwarding scans to " + serverUrl + ". Leave this process running during check-in.");

        while (running && !Thread.currentThread().isInterrupted()) {
            sendHeartbeatIfDue(serverUrl, terminal.getName());
            if (!terminal.waitForCardPresent(500)) continue;

            try {
                String uid = readUid(terminal);
                if (uid != null) {
                    postJson(serverUrl + "/api/reader/scan", "{\"nfc_uid\":\"" + uid + "\"}");
                    System.out.println("Card UID read: " + uid);
                }
            } catch (CardException error) {
                System.err.println("Card read failed: " + error.getMessage());
            } catch (RuntimeException error) {
                System.err.println("Could not forward card scan: " + error.getMessage());
            }

            while (running && terminal.isCardPresent()) {
                sendHeartbeatIfDue(serverUrl, terminal.getName());
                terminal.waitForCardAbsent(1000);
            }
            System.out.println("Ready for next card.");
        }
    }

    private static String readUid(CardTerminal terminal) throws CardException {
        Card card = terminal.connect("*");
        try {
            ResponseAPDU response = card.getBasicChannel().transmit(
                    new CommandAPDU(new byte[] { (byte) 0xFF, (byte) 0xCA, 0x00, 0x00, 0x00 }));
            if (response.getSW1() != 0x90 || response.getSW2() != 0x00) {
                throw new CardException(String.format("UID command returned status %02X%02X", response.getSW1(), response.getSW2()));
            }
            byte[] uid = response.getData();
            StringBuilder hex = new StringBuilder(uid.length * 2);
            for (byte value : uid) hex.append(String.format("%02X", value & 0xFF));
            return hex.toString();
        } finally {
            try {
                card.disconnect(false);
            } catch (CardException ignored) {
                // The card may already have been removed.
            }
        }
    }

    private static void sendHeartbeatIfDue(String serverUrl, String readerName) {
        if (System.currentTimeMillis() - lastHeartbeat >= 5000) sendHeartbeat(serverUrl, readerName);
    }

    private static void sendHeartbeat(String serverUrl, String readerName) {
        String escapedReader = readerName.replace("\\", "\\\\").replace("\"", "\\\"");
        try {
            postJson(serverUrl + "/api/reader/heartbeat", "{\"reader\":\"" + escapedReader + "\"}");
            lastHeartbeat = System.currentTimeMillis();
        } catch (RuntimeException error) {
            System.err.println("Dashboard is not reachable at " + serverUrl + ": " + error.getMessage());
        }
    }

    private static void postJson(String url, String json) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(3))
                    .header("Content-Type", "application/json")
                    .headers(BRIDGE_TOKEN == null || BRIDGE_TOKEN.isBlank()
                            ? new String[0]
                            : new String[] { "Authorization", "Bearer " + BRIDGE_TOKEN })
                    .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new IllegalStateException("HTTP " + response.statusCode() + ": " + response.body());
            }
        } catch (IOException | InterruptedException error) {
            if (error instanceof InterruptedException) Thread.currentThread().interrupt();
            throw new RuntimeException(error.getMessage(), error);
        }
    }
}
