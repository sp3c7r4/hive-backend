export interface FacebookTokenInterface {
	accessToken: string;
	expiryDate: number;
	tokenType: string;
}

export interface FacebookUserInfo {
	id: string;
	email: string;
	first_name: string;
	last_name: string;
	picture?: {
		data: {
			url: string;
		};
	};
}

export interface FacebookOAuthResponse {
	tokens: FacebookTokenInterface;
	userInfo: FacebookUserInfo;
}
