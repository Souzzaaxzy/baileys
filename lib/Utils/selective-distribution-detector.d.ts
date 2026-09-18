export declare const DECRYPT_FAIL_ATTR = "decrypt-fail";
export declare const DECRYPT_FAIL_HIDE = "hide";
export declare const hasDecryptFailHide: (attrs: any) => boolean;
export declare const isSelectiveDistributionFailure: ({ encType, encAttrs, error }: {
    encType: any;
    encAttrs: any;
    error: any;
}) => boolean;
export declare const buildSelectiveDistributionReport: ({ stanza, error }: {
    stanza: any;
    error: any;
}) => {
    kind: string;
    messageId: any;
    groupJid: any;
    author: any;
    encType: any;
    decryptFail: any;
    addressedDeviceCount: number;
    reason: any;
};
//# sourceMappingURL=selective-distribution-detector.d.ts.map
