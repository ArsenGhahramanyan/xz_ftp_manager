import { ConnectionProfile, IProtocolAdapter } from '../models/interfaces';
import { FtpAdapter } from './FtpAdapter';
import { FtpsAdapter } from './FtpsAdapter';
import { SftpAdapter } from './SftpAdapter';

/**
 * Creates the correct protocol adapter based on the profile's protocol setting.
 */
export class ConnectionFactory {
    static createAdapter(profile: ConnectionProfile): IProtocolAdapter {
        switch (profile.protocol) {
            case 'ftp':
                return new FtpAdapter();
            case 'ftps':
                return new FtpsAdapter();
            case 'sftp':
                return new SftpAdapter();
            default:
                throw new Error(`Unsupported protocol: ${profile.protocol}`);
        }
    }
}
