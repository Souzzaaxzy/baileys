export type ContactRecord = {
    id: string;
    name?: string;
    notify?: string;
    verifiedName?: string;
    username?: string;
    lid?: string;
    phoneNumber?: string;
    imgUrl?: string;
    [key: string]: any;
};
export type ContactStore = {
    upsert: (contact: ContactRecord) => void;
    getName: (jid: string) => string | undefined;
    getContact: (jid: string) => ContactRecord | undefined;
    getAll: () => ContactRecord[];
    remove: (jid: string) => boolean;
    clear: () => void;
    _size: () => number;
    _resolve: (jid: string) => ContactRecord | undefined;
};
export declare function makeContactStore(opts?: {
    ev?: any;
    max?: number;
    ttlMs?: number;
    now?: () => number;
}): ContactStore;
//# sourceMappingURL=contact-store.d.ts.map
