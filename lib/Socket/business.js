import { getRawMediaUploadData } from '../Utils/index.js';
import { parseBusinessProfileNode, parseCatalogNode, parseCollectionsNode, parseOrderDetailsNode, parseProductNode, toBusinessProfileNode, toCoverPhotoNode, toProductNode, uploadingNecessaryImagesOfProduct } from '../Utils/business.js';
import { jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary/index.js';
import { getBinaryNodeChild } from '../WABinary/generic-utils.js';
import { makeMessagesRecvSocket } from './messages-recv.js';
export const makeBusinessSocket = (config) => {
    const sock = makeMessagesRecvSocket(config);
    const { authState, query, waUploadToServer } = sock;
    const updateBussinesProfile = async (args) => {
        const node = toBusinessProfileNode(args);
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:biz'
            },
            content: [
                {
                    tag: 'business_profile',
                    attrs: {
                        v: '3',
                        mutation_type: 'delta'
                    },
                    content: node
                }
            ]
        });
        return result;
    };
    const updateCoverPhoto = async (photo) => {
        const { fileSha256, filePath } = await getRawMediaUploadData(photo, 'biz-cover-photo');
        const fileSha256B64 = fileSha256.toString('base64');
        const { meta_hmac, fbid, ts } = await waUploadToServer(filePath, {
            fileEncSha256B64: fileSha256B64,
            mediaType: 'biz-cover-photo'
        });
        await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:biz'
            },
            content: [
                {
                    tag: 'business_profile',
                    attrs: {
                        v: '3',
                        mutation_type: 'delta'
                    },
                    content: [
                        toCoverPhotoNode({ op: 'update', id: fbid, token: meta_hmac, ts })
                    ]
                }
            ]
        });
        return fbid;
    };
    const removeCoverPhoto = async (id) => {
        return await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:biz'
            },
            content: [
                {
                    tag: 'business_profile',
                    attrs: {
                        v: '3',
                        mutation_type: 'delta'
                    },
                    content: [
                        toCoverPhotoNode({ op: 'delete', id })
                    ]
                }
            ]
        });
    };
    /**
     * Read a business profile (`w:biz` / `business_profile`).
     *
     * Same IQ the `chats.js` `getBusinessProfile` issues; it lives here as well so
     * the parser in `Utils/business.js` (which is the one that knows the full
     * BinaryNode shape, including several websites and the cover photo id) has a
     * socket entry point. `getBusinessProfile` in chats.js is kept untouched for
     * compatibility.
     *
     * @returns {Promise<object|undefined>} parsed profile, or undefined when the
     *   number has no business profile
     */
    const getBusinessProfileV2 = async (jid) => {
        const target = jidNormalizedUser(jid || authState.creds.me?.id);
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                xmlns: 'w:biz',
                type: 'get'
            },
            content: [
                {
                    tag: 'business_profile',
                    attrs: { v: '244' },
                    content: [
                        {
                            tag: 'profile',
                            attrs: { jid: target }
                        }
                    ]
                }
            ]
        });
        return parseBusinessProfileNode(result);
    };
    const getCatalog = async ({ jid, limit, cursor }) => {
        jid = jid || authState.creds.me?.id;
        jid = jidNormalizedUser(jid);
        const queryParamNodes = [
            {
                tag: 'limit',
                attrs: {},
                content: Buffer.from((limit || 10).toString())
            },
            {
                tag: 'width',
                attrs: {},
                content: Buffer.from('100')
            },
            {
                tag: 'height',
                attrs: {},
                content: Buffer.from('100')
            }
        ];
        if (cursor) {
            queryParamNodes.push({
                tag: 'after',
                attrs: {},
                content: cursor
            });
        }
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'get',
                xmlns: 'w:biz:catalog'
            },
            content: [
                {
                    tag: 'product_catalog',
                    attrs: {
                        jid,
                        allow_shop_source: 'true'
                    },
                    content: queryParamNodes
                }
            ]
        });
        return parseCatalogNode(result);
    };
    const getCollections = async (jid, limit = 51) => {
        jid = jid || authState.creds.me?.id;
        jid = jidNormalizedUser(jid);
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'get',
                xmlns: 'w:biz:catalog',
                smax_id: '35'
            },
            content: [
                {
                    tag: 'collections',
                    attrs: {
                        biz_jid: jid
                    },
                    content: [
                        {
                            tag: 'collection_limit',
                            attrs: {},
                            content: Buffer.from(limit.toString())
                        },
                        {
                            tag: 'item_limit',
                            attrs: {},
                            content: Buffer.from(limit.toString())
                        },
                        {
                            tag: 'width',
                            attrs: {},
                            content: Buffer.from('100')
                        },
                        {
                            tag: 'height',
                            attrs: {},
                            content: Buffer.from('100')
                        }
                    ]
                }
            ]
        });
        return parseCollectionsNode(result);
    };
    const getOrderDetails = async (orderId, tokenBase64) => {
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'get',
                xmlns: 'fb:thrift_iq',
                smax_id: '5'
            },
            content: [
                {
                    tag: 'order',
                    attrs: {
                        op: 'get',
                        id: orderId
                    },
                    content: [
                        {
                            tag: 'image_dimensions',
                            attrs: {},
                            content: [
                                {
                                    tag: 'width',
                                    attrs: {},
                                    content: Buffer.from('100')
                                },
                                {
                                    tag: 'height',
                                    attrs: {},
                                    content: Buffer.from('100')
                                }
                            ]
                        },
                        {
                            tag: 'token',
                            attrs: {},
                            content: Buffer.from(tokenBase64)
                        }
                    ]
                }
            ]
        });
        return parseOrderDetailsNode(result);
    };
    const productUpdate = async (productId, update) => {
        update = await uploadingNecessaryImagesOfProduct(update, waUploadToServer);
        const editNode = toProductNode(productId, update);
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:biz:catalog'
            },
            content: [
                {
                    tag: 'product_catalog_edit',
                    attrs: { v: '1' },
                    content: [
                        editNode,
                        {
                            tag: 'width',
                            attrs: {},
                            content: '100'
                        },
                        {
                            tag: 'height',
                            attrs: {},
                            content: '100'
                        }
                    ]
                }
            ]
        });
        const productCatalogEditNode = getBinaryNodeChild(result, 'product_catalog_edit');
        const productNode = getBinaryNodeChild(productCatalogEditNode, 'product');
        return parseProductNode(productNode);
    };
    const productCreate = async (create) => {
        // ensure isHidden is defined
        create.isHidden = !!create.isHidden;
        create = await uploadingNecessaryImagesOfProduct(create, waUploadToServer);
        const createNode = toProductNode(undefined, create);
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:biz:catalog'
            },
            content: [
                {
                    tag: 'product_catalog_add',
                    attrs: { v: '1' },
                    content: [
                        createNode,
                        {
                            tag: 'width',
                            attrs: {},
                            content: '100'
                        },
                        {
                            tag: 'height',
                            attrs: {},
                            content: '100'
                        }
                    ]
                }
            ]
        });
        const productCatalogAddNode = getBinaryNodeChild(result, 'product_catalog_add');
        const productNode = getBinaryNodeChild(productCatalogAddNode, 'product');
        return parseProductNode(productNode);
    };
    const productDelete = async (productIds) => {
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:biz:catalog'
            },
            content: [
                {
                    tag: 'product_catalog_delete',
                    attrs: { v: '1' },
                    content: productIds.map(id => ({
                        tag: 'product',
                        attrs: {},
                        content: [
                            {
                                tag: 'id',
                                attrs: {},
                                content: Buffer.from(id)
                            }
                        ]
                    }))
                }
            ]
        });
        const productCatalogDelNode = getBinaryNodeChild(result, 'product_catalog_delete');
        return {
            deleted: +(productCatalogDelNode?.attrs.deleted_count || 0)
        };
    };
    return {
        ...sock,
        logger: config.logger,
        getOrderDetails,
        getCatalog,
        getCollections,
        getBusinessProfileV2,
        productCreate,
        productDelete,
        productUpdate,
        updateBussinesProfile,
        updateBusinessProfile: updateBussinesProfile,
        updateCoverPhoto,
        removeCoverPhoto
    };
};
//# sourceMappingURL=business.js.map