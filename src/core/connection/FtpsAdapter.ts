import { ConnectionProfile } from '../models/interfaces';
import { FtpAdapter } from './FtpAdapter';

/**
 * FTP over TLS (FTPS) adapter.
 * Extends FtpAdapter, overriding only connect() to negotiate TLS.
 */
export class FtpsAdapter extends FtpAdapter {
    async connect(profile: ConnectionProfile, password?: string, _passphrase?: string): Promise<void> {
        // Import Client at call-time so the base class constructor path stays clean
        const { Client } = await import('basic-ftp');
        this.client = new Client(profile.timeoutSeconds * 1000);

        this.client.ftp.log = (message: string) => {
            const level = message.startsWith('< ')
                ? 'response' as const
                : message.startsWith('> ')
                    ? 'command' as const
                    : 'info' as const;
            const safe = message
                .replace(/^(> PASS )(.*)$/, '$1***')
                .replace(/^(> USER )(.*)$/, '$1***');
            this._onLog.fire({ level, message: safe });
        };

        this.client.ftp.socket.once('close', () => {
            if (this.connected) {
                this.connected = false;
                this._onDidDisconnect.fire({ reason: 'Connection closed by server' });
            }
        });

        // Determine the `secure` value from the encryption mode
        let secure: boolean | 'implicit';
        switch (profile.encryptionMode) {
            case 'implicit':
                secure = 'implicit';
                break;
            case 'explicit':
            default:
                secure = true;
                break;
        }

        await this.client.access({
            host: profile.host,
            port: profile.port,
            user: profile.username,
            password: password ?? '',
            secure,
            secureOptions: {
                rejectUnauthorized: !profile.trustSelfSigned,
                servername: profile.host,
                minVersion: 'TLSv1.2',
            },
        });

        this._onLog.fire({
            level: 'info',
            message: `Connected to ${profile.host}:${profile.port} via FTPS (${profile.encryptionMode})`,
        });
        this.connected = true;
    }
}
