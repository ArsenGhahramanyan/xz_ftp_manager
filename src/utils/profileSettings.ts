import { ConnectionProfile, OverwriteRule } from '../core/models/interfaces';
import { ConfigService } from '../services/ConfigService';
import { StorageService } from '../services/StorageService';

/**
 * Resolve effective transfer settings for a given connection.
 * Per-profile overrides win; otherwise the workspace `ftpManager.*`
 * setting is used. `connectionId` may be undefined (e.g. for ad-hoc
 * Quick-Connect transfers); in that case all values fall back to globals.
 */
export class ProfileSettings {
    constructor(
        private readonly configService: ConfigService,
        private readonly storageService: StorageService,
    ) {}

    private profile(connectionId: string | undefined): ConnectionProfile | undefined {
        return connectionId ? this.storageService.getProfileById(connectionId) : undefined;
    }

    overwriteRule(connectionId: string | undefined): OverwriteRule {
        return this.profile(connectionId)?.defaultOverwriteRule ?? this.configService.getDefaultOverwriteRule();
    }

    transferMode(connectionId: string | undefined): 'auto' | 'binary' | 'ascii' {
        return this.profile(connectionId)?.transferMode ?? this.configService.getTransferMode();
    }

    autoUploadOnSave(connectionId: string | undefined): boolean {
        return this.profile(connectionId)?.autoUploadOnSave ?? this.configService.getAutoUploadOnSave();
    }
}
