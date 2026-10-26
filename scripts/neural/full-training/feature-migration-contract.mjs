/** Named one-way append-only feature migration. Not an exception to ordinary forks. */
import {digest} from './state.mjs';
export const FEATURE_MIGRATION_ID='input-conf-to-slot-group-alignment-zero-v1';
export const ALIGNED_SOURCE_TRANSITION='latest-default-to-aligned-warmup-runorder-v3';
export const FEATURE_MIGRATION_CONTRACT=Object.freeze({id:FEATURE_MIGRATION_ID,oldVersion:'full-v2-sparse-catalog-2-input-conf',oldHash:'116a7915c860ef4f44b9629f93df2abd',oldCount:53006,oldManifestSha256:'9ed2bc41db0440e586be39b86a9844f52f646f38fafdb255b25a776e0667e0c7',newVersion:'full-v2-sparse-catalog-3-slot-group-alignment',newHash:'d1ff8f23058649914e797c6159a1822b',newCount:56177,newManifestSha256:'da384b68ed3860ca5c7fe777adfe5ee3cc1bd51dbc1a503be9d7d4ccd861ad34',migrationModule:'src/optimizer/neural/fullPolicyMigration.ts',migrationModuleHash:'7938bef7c61430e92a39dd110eb95dc21186ecd7d67e8d70b29da59185d068f5'});
export const FEATURE_MIGRATION_SOURCE_PAIRS=Object.freeze({
 'src/optimizer/neural/fullFeatures.ts':Object.freeze({old:'6cf6e1eb5deac77619027570ad99eddbbb18d555e9d436919e2c8af7fe2a204e',next:'6aa679fbcf8b78fe0049e5ede0ea3fafb08d650689acbe158fa3cffe18522c99'}),
 'src/optimizer/neural/fullPolicy.ts':Object.freeze({old:'9c41d1b20e639120c8ffdaf378630fc5ad1007af8fcb00dd47ab92d4bf896314',next:'aea60d452d8c4162786dad71a121e5ec34b8dc52e54ce07e2b0f6515c62c1b3a'})
});
export function verifyFeatureMigrationImplementation(provenance) {
    for(const[path,pair]of Object.entries(FEATURE_MIGRATION_SOURCE_PAIRS))if(provenance.sourceHashes[path]!==pair.next)throw Error('Unreviewed feature migration source: '+path);
    if(provenance.sourceHashes[FEATURE_MIGRATION_CONTRACT.migrationModule]!==FEATURE_MIGRATION_CONTRACT.migrationModuleHash)throw Error('Unreviewed feature migration implementation');
}
export function isReviewedFeatureSourceDrift(path,oldHash,newHash){const pair=FEATURE_MIGRATION_SOURCE_PAIRS[path];return !!pair&&pair.old===oldHash&&pair.next===newHash;}
function parse(bytes,version,hash,count){
    if(!(bytes instanceof Uint8Array)||bytes.length<8)throw Error('Invalid migration binary');
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),length=view.getUint32(4,true);
    if(view.getUint32(0,true)!==0x46503242||length>65536||length+8>bytes.length)throw Error('Invalid migration binary header');
    const header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(8,8+length))),n=header.hiddenSize;
    if(header.version!==2||header.featureVersion!==version||header.manifestHash!==hash||header.featureCount!==count||!Number.isSafeInteger(n)||n<1||n>256||bytes.length!==8+length+8*(count+2)*n)throw Error('Migration binary feature/dimension contract mismatch');
    if(!header.metadata||!Number.isSafeInteger(header.metadata.seed)||header.metadata.seed<0||header.metadata.seed>0xffffffff||!Number.isSafeInteger(header.metadata.trainingUpdates)||header.metadata.trainingUpdates<0)throw Error('Migration binary metadata mismatch');
    for(let offset=8+length;offset<bytes.length;offset+=8)if(!Number.isFinite(view.getFloat64(offset,true)))throw Error('Nonfinite migration parameter');
    return {header,offset:8+length,rowBytes:8*n};
}
export function verifyFeatureMigrationBytes(oldBytes,newBytes) {
    const c=FEATURE_MIGRATION_CONTRACT,a=parse(oldBytes,c.oldVersion,c.oldHash,c.oldCount),b=parse(newBytes,c.newVersion,c.newHash,c.newCount);
    const expected={...a.header,featureVersion:c.newVersion,manifestHash:c.newHash,featureCount:c.newCount,metadata:{...a.header.metadata}};delete expected.metadata.resume;
    if(digest(expected)!==digest(b.header))throw Error('Migration changed metadata beyond feature header and resume reset');
    const ranges=[['inputWeights',a.offset,b.offset,c.oldCount*a.rowBytes],['hiddenBias',a.offset+c.oldCount*a.rowBytes,b.offset+c.newCount*b.rowBytes,a.rowBytes],['outputWeights',a.offset+(c.oldCount+1)*a.rowBytes,b.offset+(c.newCount+1)*b.rowBytes,a.rowBytes]];
    const tensors=ranges.map(([name,oldOffset,newOffset,byteLength])=>{const oldRange=oldBytes.subarray(oldOffset,oldOffset+byteLength),newRange=newBytes.subarray(newOffset,newOffset+byteLength);if(digest(oldRange)!==digest(newRange))throw Error('Migration changed old parameter bytes: '+name);return {name,oldOffset,newOffset,byteLength,oldHash:digest(oldRange),newHash:digest(newRange),bitwiseEqual:true};});
    const newOffset=b.offset+c.oldCount*b.rowBytes,byteLength=(c.newCount-c.oldCount)*b.rowBytes,added=newBytes.subarray(newOffset,newOffset+byteLength);
    if(added.some(value=>value!==0))throw Error('Migration appended rows are not positive zero bytes');
    tensors.push({name:'appendedInputRows',oldOffset:null,newOffset,byteLength,newHash:digest(added),allZero:true});
    return {schemaVersion:1,kind:FEATURE_MIGRATION_ID,contract:c,oldModelHash:digest(oldBytes),newModelHash:digest(newBytes),oldHeaderHash:digest(a.header),newHeaderHash:digest(b.header),hiddenSize:b.header.hiddenSize,addedRows:c.newCount-c.oldCount,metadata:{...b.header.metadata},resumeReset:true,newTrainingUpdates:0,tensors};
}
export function verifyFeatureMigrationPopulation(parentDataset,dataset,lineage){
    const c=FEATURE_MIGRATION_CONTRACT;
    if(parentDataset.purpose!=='train'||dataset.purpose!=='train'||parentDataset.featureManifestHash!==c.oldHash||dataset.featureManifestHash!==c.newHash||digest(parentDataset)!==lineage.parent.datasetHash||!parentDataset.records.length)throw Error('Feature migration parent population commitment mismatch');
    const identity=r=>({familyId:r.familyId,inputHash:digest(r.input),teacherRecordHash:r.teacherRecordHash,teacherSemanticHash:r.teacherSemanticHash}),order=(a,b)=>a.familyId<b.familyId?-1:a.familyId>b.familyId?1:0;
    const expected=parentDataset.records.map(identity).sort(order),parentMemberIndex=dataset.sourceUnion?0:null;
    if(dataset.sourceUnion&&dataset.sourceUnion.kind!=='independent-full-train-union-v1')throw Error('Unknown migration union population');
    const memberRecords=parentMemberIndex===null?dataset.records:dataset.records.filter(r=>r.sourceMemberIndex===0),actual=memberRecords.map(identity).sort(order);
    if(new Set(expected.map(r=>r.familyId)).size!==expected.length||dataset.records.some(r=>r.input?.split!=='train')||digest(expected)!==digest(actual))throw Error('Feature migration changed original parent population');
    return {parentDatasetHash:digest(parentDataset),newDatasetHash:digest(dataset),parentFamilyCount:expected.length,parentMemberIndex,additionalFamilies:dataset.records.length-expected.length,preserved:expected};
}
