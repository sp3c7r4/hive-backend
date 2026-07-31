export interface BaseSocialService {
	sendMessage: (message: string, params: any) => Promise<any>;
	sendImage: (image: Buffer, params: any) => Promise<any>;
	sendDocument: (document: Buffer, params: any) => Promise<any>;
	sendLink: (url: string, params: any) => Promise<any>;
}
