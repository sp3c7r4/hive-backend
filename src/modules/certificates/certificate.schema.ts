import { z } from "zod";

export const issueCertificateSchema = z.object({
	courseId: z.number().int(),
	enrollmentId: z.number().int(),
	completionPercent: z.number().int().min(0).max(100),
	quizScorePercent: z.number().int().min(0).max(100),
	attendancePercent: z.number().int().min(0).max(100),
	minCompletion: z.number().int().min(0).max(100),
	minQuiz: z.number().int().min(0).max(100),
	minAttendance: z.number().int().min(0).max(100),
	allowCertificate: z.boolean(),
});
