import { mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';

function clampWidth(width) {
  const value = Number(width);
  if (!Number.isFinite(value)) return 320;
  return Math.max(120, Math.min(900, Math.round(value)));
}

const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: element => {
          const raw = element.getAttribute('data-width') || element.getAttribute('width');
          if (!raw) return null;
          const parsed = Number.parseInt(raw, 10);
          return Number.isFinite(parsed) ? parsed : null;
        },
        renderHTML: attributes => {
          if (!attributes.width) return {};
          const width = clampWidth(attributes.width);
          return {
            width,
            'data-width': width,
          };
        },
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let currentNode = node;
      const wrapper = document.createElement('span');
      wrapper.className = 'tiptap-resizable-image';
      wrapper.contentEditable = 'false';
      wrapper.style.display = 'inline-block';
      wrapper.style.position = 'relative';
      wrapper.style.maxWidth = '90%';
      wrapper.style.lineHeight = '0';
      wrapper.style.overflow = 'hidden';
      wrapper.style.borderRadius = '0';

      const image = document.createElement('img');
      image.draggable = false;
      image.src = currentNode.attrs.src || '';
      image.alt = currentNode.attrs.alt || '';
      image.title = currentNode.attrs.title || '';
      image.style.display = 'block';
      image.style.width = '100%';
      image.style.height = 'auto';
      image.style.maxWidth = 'none';
      image.style.pointerEvents = 'none';
      image.style.borderRadius = '0';

      const resizeHandle = document.createElement('span');
      resizeHandle.className = 'tiptap-image-resize-handle';
      resizeHandle.style.position = 'absolute';
      resizeHandle.style.right = '0';
      resizeHandle.style.bottom = '0';
      resizeHandle.style.width = '12px';
      resizeHandle.style.height = '12px';
      resizeHandle.style.cursor = 'nwse-resize';
      resizeHandle.style.background = 'rgba(0,0,0,0.45)';
      resizeHandle.style.borderTop = '1px solid rgba(255,255,255,0.7)';
      resizeHandle.style.borderLeft = '1px solid rgba(255,255,255,0.7)';
      resizeHandle.style.touchAction = 'none';

      const getContainerMaxWidth = () => {
        const parentWidth = wrapper.parentElement?.getBoundingClientRect?.().width || 0;
        if (!Number.isFinite(parentWidth) || parentWidth <= 0) return 900;
        return Math.max(120, Math.min(900, Math.round(parentWidth * 0.9)));
      };

      const normalizeWidth = (width) => {
        const nextWidth = clampWidth(width);
        return Math.min(nextWidth, getContainerMaxWidth());
      };

      const applyWidth = (width) => {
        wrapper.style.width = `${normalizeWidth(width)}px`;
      };

      const persistWidth = () => {
        const pos = getPos?.();
        if (typeof pos !== 'number') return;
        const width = clampWidth(wrapper.getBoundingClientRect().width);
        editor.chain().focus().command(({ tr }) => {
          tr.setNodeMarkup(pos, undefined, { ...currentNode.attrs, width });
          return true;
        }).run();
      };

      applyWidth(currentNode.attrs.width || 320);

      const onImageLoad = () => {
        const hasStoredWidth = Number.isFinite(Number(currentNode.attrs.width));
        if (!hasStoredWidth) {
          applyWidth(image.naturalWidth || 320);
          persistWidth();
        } else {
          applyWidth(currentNode.attrs.width);
        }
      };
      image.addEventListener('load', onImageLoad);

      const onResizeStop = () => {
        persistWidth();
      };

      let isResizing = false;
      let startX = 0;
      let startWidth = 0;

      const getClientX = (event) => {
        if (event.touches?.length) return event.touches[0].clientX;
        if (event.changedTouches?.length) return event.changedTouches[0].clientX;
        return event.clientX;
      };

      const onResizeMove = (event) => {
        if (!isResizing) return;
        const clientX = getClientX(event);
        if (!Number.isFinite(clientX)) return;
        const delta = clientX - startX;
        applyWidth(startWidth + delta);
        event.preventDefault();
      };

      const stopResize = () => {
        if (!isResizing) return;
        isResizing = false;
        document.removeEventListener('mousemove', onResizeMove);
        document.removeEventListener('mouseup', stopResize);
        document.removeEventListener('touchmove', onResizeMove);
        document.removeEventListener('touchend', stopResize);
        onResizeStop();
      };

      const startResize = (event) => {
        const clientX = getClientX(event);
        if (!Number.isFinite(clientX)) return;
        isResizing = true;
        startX = clientX;
        startWidth = normalizeWidth(wrapper.getBoundingClientRect().width);
        document.addEventListener('mousemove', onResizeMove);
        document.addEventListener('mouseup', stopResize);
        document.addEventListener('touchmove', onResizeMove, { passive: false });
        document.addEventListener('touchend', stopResize);
        event.preventDefault();
        event.stopPropagation();
      };

      resizeHandle.addEventListener('mousedown', startResize);
      resizeHandle.addEventListener('touchstart', startResize, { passive: false });

      wrapper.appendChild(image);
      wrapper.appendChild(resizeHandle);

      return {
        dom: wrapper,
        update(updatedNode) {
          if (updatedNode.type !== currentNode.type) return false;
          currentNode = updatedNode;
          if (image.src !== (updatedNode.attrs.src || '')) {
            image.src = updatedNode.attrs.src || '';
          }
          image.alt = updatedNode.attrs.alt || '';
          image.title = updatedNode.attrs.title || '';
          applyWidth(updatedNode.attrs.width || 320);
          return true;
        },
        destroy() {
          stopResize();
          image.removeEventListener('load', onImageLoad);
          resizeHandle.removeEventListener('mousedown', startResize);
          resizeHandle.removeEventListener('touchstart', startResize);
        },
      };
    };
  },
});

export default ResizableImage;
