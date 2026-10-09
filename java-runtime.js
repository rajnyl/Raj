const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const JAVA_MAJOR_VERSION = 21;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const TRUSTED_HOSTS = new Set([
    'api.adoptium.net',
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com'
]);

function parseJavaMajorVersion(output) {
    const match = /version "(?:1\.)?(\d+)/.exec(output);
    return match ? Number(match[1]) : null;
}

function supportsJava11(executable) {
    const result = spawnSync(executable, ['-version'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const majorVersion = parseJavaMajorVersion(output);
    return result.status === 0 && majorVersion !== null && majorVersion >= 11;
}

function trustedUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !TRUSTED_HOSTS.has(url.hostname)) {
        throw new Error(`Refusing to download Java from an untrusted URL: ${url.hostname}`);
    }
    return url;
}

function openHttps(url, redirects = 0) {
    const target = trustedUrl(url);
    return new Promise((resolve, reject) => {
        const request = https.get(target, { headers: { 'User-Agent': 'NCGG-Attendance-Dashboard' } }, (response) => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                const location = response.headers.location;
                response.resume();
                if (!location || redirects >= 5) {
                    reject(new Error('Java download redirected too many times or omitted its destination.'));
                    return;
                }
                let nextUrl;
                try {
                    nextUrl = new URL(location, target).toString();
                    trustedUrl(nextUrl);
                } catch (error) {
                    reject(error);
                    return;
                }
                openHttps(nextUrl, redirects + 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Java download server returned HTTP ${response.statusCode}.`));
                return;
            }
            resolve(response);
        });
        request.setTimeout(60000, () => request.destroy(new Error('Java download timed out.')));
        request.on('error', reject);
    });
}

async function readJson(url) {
    const response = await openHttps(url);
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('Java release information was unexpectedly large.');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function adoptiumArchitecture(arch) {
    const mapping = { x64: 'x64', ia32: 'x86', arm64: 'aarch64' };
    const architecture = mapping[arch];
    if (!architecture) throw new Error(`Automatic Java setup does not support this device architecture (${arch}).`);
    return architecture;
}

async function downloadJavaArchive(asset, archivePath) {
    if (!/^[a-f\d]{64}$/i.test(asset.checksum)) {
        throw new Error('Adoptium did not provide a valid SHA-256 checksum for Java.');
    }
    const response = await openHttps(asset.link);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const meter = new Transform({
        transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > MAX_DOWNLOAD_BYTES) {
                callback(new Error('Java download exceeded the 200 MB safety limit.'));
                return;
            }
            hash.update(chunk);
            callback(null, chunk);
        }
    });
    await pipeline(response, meter, fs.createWriteStream(archivePath, { flags: 'wx' }));
    if (hash.digest('hex').toLowerCase() !== asset.checksum.toLowerCase()) {
        throw new Error('The downloaded Java runtime failed its SHA-256 checksum check.');
    }
}

function extractArchive(archivePath, destination) {
    return new Promise((resolve, reject) => {
        const extractor = spawn('tar.exe', ['-xf', archivePath, '-C', destination], {
            windowsHide: true,
            stdio: 'ignore'
        });
        extractor.once('error', reject);
        extractor.once('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Could not extract the Java runtime archive (tar exited with code ${code}).`));
        });
    });
}

async function installJavaRuntime(userDataPath, arch = process.arch) {
    if (process.platform !== 'win32') {
        throw new Error('Java is not installed. Automatic Java setup currently supports Windows only; install Java 11 or newer and restart the dashboard.');
    }

    const architecture = adoptiumArchitecture(arch);
    const runtimePath = path.join(userDataPath, 'java-runtime');
    const javaExecutable = path.join(runtimePath, 'bin', 'java.exe');
    if (fs.existsSync(javaExecutable) && supportsJava11(javaExecutable)) return javaExecutable;
    fs.rmSync(runtimePath, { recursive: true, force: true });

    const metadataUrl = `https://api.adoptium.net/v3/assets/latest/${JAVA_MAJOR_VERSION}/hotspot?architecture=${architecture}&image_type=jre&os=windows&vendor=eclipse`;
    const releases = await readJson(metadataUrl);
    const binary = Array.isArray(releases) ? releases[0]?.binary : null;
    const asset = binary?.architecture === architecture && binary.image_type === 'jre' && binary.os === 'windows'
        ? binary.package
        : null;
    if (!asset?.link || !asset.checksum) {
        throw new Error('Adoptium did not provide a Java runtime for this Windows device.');
    }

    const suffix = `${process.pid}-${Date.now()}`;
    const archivePath = path.join(userDataPath, `java-runtime-${suffix}.zip`);
    const stagingPath = path.join(userDataPath, `java-runtime-staging-${suffix}`);
    try {
        fs.mkdirSync(stagingPath, { recursive: true });
        await downloadJavaArchive(asset, archivePath);
        await extractArchive(archivePath, stagingPath);
        const runtimeFolder = fs.readdirSync(stagingPath, { withFileTypes: true })
            .find((entry) => entry.isDirectory() && fs.existsSync(path.join(stagingPath, entry.name, 'bin', 'java.exe')));
        if (!runtimeFolder) throw new Error('The downloaded Java archive did not contain java.exe.');

        fs.rmSync(runtimePath, { recursive: true, force: true });
        fs.renameSync(path.join(stagingPath, runtimeFolder.name), runtimePath);
        return javaExecutable;
    } finally {
        fs.rmSync(archivePath, { force: true });
        fs.rmSync(stagingPath, { recursive: true, force: true });
    }
}

async function ensureJavaExecutable(userDataPath) {
    const cachedJava = path.join(userDataPath, 'java-runtime', 'bin', 'java.exe');
    if (fs.existsSync(cachedJava) && supportsJava11(cachedJava)) return cachedJava;
    if (supportsJava11('java')) return 'java';
    return installJavaRuntime(userDataPath);
}

module.exports = {
    adoptiumArchitecture,
    ensureJavaExecutable,
    parseJavaMajorVersion
};
