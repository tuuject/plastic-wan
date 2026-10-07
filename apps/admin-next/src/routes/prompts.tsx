import { createFileRoute } from '@tanstack/react-router';
import PromptsPage from '@/pages/prompts';

export const Route = createFileRoute('/prompts')({
  component: PromptsPage,
});
