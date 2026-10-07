import { join } from 'node:path';
import { capability } from '../../capabilities/execute-tool.ts';
import { definePlugin } from '../plugin.ts';
import { createImageGenerateTool, createListImageModelsTool } from './image.ts';

/**
 * Image generation. Contributes nothing unless the host wired an image bridge
 * and generation is enabled for the current invocation, so a runtime without
 * (or with a disabled) image configuration exposes neither the tool nor — via
 * the skill list staying empty — hints about it.
 */
export default definePlugin({
  id: 'image',
  skills: [join(import.meta.dirname, 'skills', 'image-generation')],
  capabilities: (scope) => {
    if (scope.image === undefined || !scope.image.enabled()) {
      return [];
    }
    return [capability(createImageGenerateTool(scope), true), capability(createListImageModelsTool(scope), false)];
  },
});
