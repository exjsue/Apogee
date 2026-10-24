// Preloaded with --import in a test: any attempt to open a network connection stops the process.
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";

const stop = (what) => () => {
  process.stderr.write(`NETWORK ATTEMPT: ${what}\n`);
  process.exit(97);
};

globalThis.fetch = stop("fetch");
net.Socket.prototype.connect = stop("net.Socket.connect");
net.connect = stop("net.connect");
net.createConnection = stop("net.createConnection");
tls.connect = stop("tls.connect");
dns.lookup = stop("dns.lookup");
dns.resolve = stop("dns.resolve");
