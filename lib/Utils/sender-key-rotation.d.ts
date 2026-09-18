export declare const EXPERIMENTAL_SENDER_KEY_ROTATION = "experimentalSenderKeyRotation";
export declare const assertExperimentalRotationTarget: ({ groupJid, message, allowedParticipants }: {
    groupJid: any;
    message: any;
    allowedParticipants: any;
}) => {
    jids: any[];
};
export declare const logSenderKeyRotation: (logger: any, info: any) => void;
export declare const currentSenderKeyId: (record: any) => any;
export declare const restoreSenderKeyRecord: (record: any, snapshot: any) => any;
//# sourceMappingURL=sender-key-rotation.d.ts.map