import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { FileUploadMiddleware } from "@/middlewares/upload";
import { FILE_SIZES } from "@/constants/file-size";
import { ImageMimeType } from "@/enums";
import {
	onboardUserSchema,
	updateUserSchema,
	changePasswordSchema,
} from "./user.schema";
import { UserController } from "./user.controller";

export const userRouter = new Hono({ strict: true });
const userController = UserController.getInstance();
const jwtService = JwtService.getInstance();
const zodEngine = ZodEngine.getInstance();
const upload = FileUploadMiddleware.getInstance();

userRouter.use(jwtService.validateToken);

userRouter.get("/profile", userController.getProfile);

userRouter.put(
	"/profile",
	zodEngine.validate.body(updateUserSchema),
	userController.updateProfile,
);

userRouter.put(
	"/avatar",
	upload.single({
		fieldName: "avatar",
		sizeLimit: FILE_SIZES["5MB"],
		allowedTypes: [ImageMimeType.JPEG, ImageMimeType.PNG],
	}),
	userController.updateAvatar,
);

userRouter.put(
	"/password",
	zodEngine.validate.body(changePasswordSchema),
	userController.changePassword,
);

userRouter.post(
	"/onboard",
	zodEngine.validate.formData(onboardUserSchema),
	upload.single({
		fieldName: "avatar",
		sizeLimit: FILE_SIZES["5MB"],
		allowedTypes: [ImageMimeType.JPEG, ImageMimeType.PNG],
		optional: true,
	}),
	userController.onboard,
);

userRouter.delete("/account", userController.deleteAccount);
