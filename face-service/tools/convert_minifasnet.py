"""Convert Minivision's MiniFASNetV2 (Apache-2.0) legacy .pth checkpoint to ONNX without PyTorch.

Usage: python convert_minifasnet.py 2.7_80x80_MiniFASNetV2.pth out.onnx
BatchNorm layers are folded into the preceding conv/linear weights.
"""
import collections, pickle, struct, sys
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

DT = {'FloatStorage': np.float32, 'LongStorage': np.int64, 'IntStorage': np.int32, 'HalfStorage': np.float16}


class _Tensor:
    def __init__(self, key, offset, size, stride):
        self.key, self.offset, self.size, self.stride = key, offset, tuple(size), tuple(stride)


def _rebuild(storage, offset, size, stride, *args):
    return _Tensor(storage[1], offset, size, stride)


def load_legacy(path):
    f = open(path, 'rb')
    pickle.load(f); pickle.load(f); pickle.load(f)  # magic, protocol, sys info
    meta = {}

    class U(pickle.Unpickler):
        def find_class(self, mod, name):
            if name == '_rebuild_tensor_v2':
                return _rebuild
            if mod == 'collections' and name == 'OrderedDict':
                return collections.OrderedDict
            if mod == 'torch' and name.endswith('Storage'):
                return name
            return super().find_class(mod, name)

        def persistent_load(self, pid):
            _, stype, key, _, size, _ = pid
            meta[key] = (stype, size)
            return ('stor', key)

    state = U(f).load()
    keys = pickle.load(f)
    data = {}
    for k in keys:
        stype, _ = meta[k]
        dt = np.dtype(DT[stype])
        n = struct.unpack('<q', f.read(8))[0]
        data[k] = np.frombuffer(f.read(n * dt.itemsize), dt)
    out = collections.OrderedDict()
    for name, t in state.items():
        if not isinstance(t, _Tensor):
            continue
        base = data[t.key]
        arr = np.lib.stride_tricks.as_strided(base[t.offset:], shape=t.size,
                                              strides=tuple(s * base.itemsize for s in t.stride)).copy()
        out[name[7:] if name.startswith('module.') else name] = arr
    return out


KEEP = [32, 32, 103, 103, 64, 13, 13, 64, 13, 13, 64, 13,
        13, 64, 13, 13, 64, 231, 231, 128, 231, 231, 128, 52,
        52, 128, 26, 26, 128, 77, 77, 128, 26, 26, 128, 26, 26,
        128, 308, 308, 128, 26, 26, 128, 26, 26, 128, 512, 512]


class Builder:
    def __init__(self, sd):
        self.sd, self.nodes, self.inits, self.n = sd, [], [], 0

    def name(self, p):
        self.n += 1
        return f'{p}_{self.n}'

    def init(self, arr, p):
        nm = self.name(p)
        self.inits.append(numpy_helper.from_array(np.ascontiguousarray(arr), nm))
        return nm

    def conv_bn(self, x, prefix, stride, pad, groups, prelu):
        w = self.sd[f'{prefix}.conv.weight'].astype(np.float32)
        g, b = self.sd[f'{prefix}.bn.weight'], self.sd[f'{prefix}.bn.bias']
        m, v = self.sd[f'{prefix}.bn.running_mean'], self.sd[f'{prefix}.bn.running_var']
        s = g / np.sqrt(v + 1e-5)
        wf = (w * s[:, None, None, None]).astype(np.float32)
        bf = (b - m * s).astype(np.float32)
        y = self.name('conv')
        k = w.shape[2:]
        self.nodes.append(helper.make_node('Conv', [x, self.init(wf, 'w'), self.init(bf, 'b')], [y],
                                           strides=list(stride), pads=list(pad) * 2, group=groups,
                                           kernel_shape=list(k)))
        if prelu:
            a = self.sd[f'{prefix}.prelu.weight'].astype(np.float32).reshape(-1, 1, 1)
            z = self.name('prelu')
            self.nodes.append(helper.make_node('PRelu', [y, self.init(a, 'a')], [z]))
            return z
        return y

    def depth_wise(self, x, prefix, stride, residual):
        groups = self.sd[f'{prefix}.conv_dw.conv.weight'].shape[0]
        y = self.conv_bn(x, f'{prefix}.conv', (1, 1), (0, 0), 1, True)
        y = self.conv_bn(y, f'{prefix}.conv_dw', stride, (1, 1), groups, True)
        y = self.conv_bn(y, f'{prefix}.project', (1, 1), (0, 0), 1, False)
        if residual:
            z = self.name('add')
            self.nodes.append(helper.make_node('Add', [x, y], [z]))
            return z
        return y


def build(sd, out_path):
    b = Builder(sd)
    x = b.conv_bn('input', 'conv1', (2, 2), (1, 1), 1, True)
    x = b.conv_bn(x, 'conv2_dw', (1, 1), (1, 1), sd['conv2_dw.conv.weight'].shape[0], True)
    x = b.depth_wise(x, 'conv_23', (2, 2), False)
    for i in range(4):
        x = b.depth_wise(x, f'conv_3.model.{i}', (1, 1), True)
    x = b.depth_wise(x, 'conv_34', (2, 2), False)
    for i in range(6):
        x = b.depth_wise(x, f'conv_4.model.{i}', (1, 1), True)
    x = b.depth_wise(x, 'conv_45', (2, 2), False)
    for i in range(2):
        x = b.depth_wise(x, f'conv_5.model.{i}', (1, 1), True)
    x = b.conv_bn(x, 'conv_6_sep', (1, 1), (0, 0), 1, True)
    x = b.conv_bn(x, 'conv_6_dw', (1, 1), (0, 0), sd['conv_6_dw.conv.weight'].shape[0], False)
    fl = b.name('flat')
    b.nodes.append(helper.make_node('Flatten', [x], [fl], axis=1))
    # linear 512->128, BN1d, prob 128->3 (dropout is identity at inference)
    W1 = sd['linear.weight'].astype(np.float32)
    g, bb, m, v = sd['bn.weight'], sd['bn.bias'], sd['bn.running_mean'], sd['bn.running_var']
    s = g / np.sqrt(v + 1e-5)
    W1f = (W1 * s[:, None]).T.astype(np.float32)
    b1f = (bb - m * s).astype(np.float32)
    h = b.name('lin')
    b.nodes.append(helper.make_node('Gemm', [fl, b.init(W1f, 'w'), b.init(b1f, 'b')], [h]))
    W2 = sd['prob.weight'].astype(np.float32).T
    logits = b.name('logits')
    b.nodes.append(helper.make_node('MatMul', [h, b.init(W2, 'w')], [logits]))
    b.nodes.append(helper.make_node('Softmax', [logits], ['prob'], axis=1))
    graph = helper.make_graph(b.nodes, 'minifasnetv2',
                              [helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 3, 80, 80])],
                              [helper.make_tensor_value_info('prob', TensorProto.FLOAT, [1, 3])], b.inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, out_path)


if __name__ == '__main__':
    sd = load_legacy(sys.argv[1])
    build(sd, sys.argv[2])
    print('ok', len(sd), 'tensors')
